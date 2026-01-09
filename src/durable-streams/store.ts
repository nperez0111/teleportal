export type DurableStreamOffset = string;

export type DurableStreamRecord = {
  key: string;
  contentType: string;
  createdAt: number;
  /**
   * Tail offset (next offset after the current end)
   */
  nextOffset: DurableStreamOffset;
  /**
   * Opaque cursor used for live request collapsing.
   */
  cursor: string;
};

type StreamEntry = {
  startOffset: DurableStreamOffset;
  endOffset: DurableStreamOffset;
  bytes: Uint8Array;
};

type StreamState = {
  key: string;
  contentType: string;
  createdAt: number;
  entries: StreamEntry[];
  /**
   * Counter used to generate lexicographically sortable offsets.
   */
  offsetCounter: number;
  /**
   * Cursor value from the last live response.
   */
  cursor: string;
  /**
   * Pending long-poll resolvers waiting for new data.
   */
  waiters: Set<(value: { cursor: string } | null) => void>;
};

function padBase36(value: number, width: number) {
  const s = value.toString(36);
  return s.length >= width ? s : "0".repeat(width - s.length) + s;
}

const OFFSET_WIDTH = 16;

export function encodeOffset(counter: number): DurableStreamOffset {
  // Never generate reserved sentinel values.
  // Our offsets are fixed-width base36 strings.
  return padBase36(counter, OFFSET_WIDTH);
}

export function isReservedOffset(offset: string): boolean {
  return offset === "-1" || offset === "now";
}

export function parseOffset(offset: string): number | null {
  if (isReservedOffset(offset)) {
    return null;
  }
  // Only accept our own offsets (fixed-width base36).
  if (offset.length !== OFFSET_WIDTH) {
    return null;
  }
  if (!/^[0-9a-z]+$/.test(offset)) {
    return null;
  }
  const n = Number.parseInt(offset, 36);
  if (!Number.isFinite(n) || n < 0) {
    return null;
  }
  return n;
}

/**
 * Cursor generation per PROTOCOL.md Section 8.1, with a simplified monotonic rule.
 *
 * - Cursor is an interval number (20s windows) since 2024-10-09T00:00:00Z.
 * - Must be monotonic and never go backwards.
 * - If client echoes a cursor >= current, we advance to client+1.
 */
export function computeCursor(clientCursor?: string | null): string {
  const epochMs = Date.UTC(2024, 9 /* Oct */, 9, 0, 0, 0);
  const intervalMs = 20_000;
  const now = Date.now();
  const current = Math.floor((now - epochMs) / intervalMs);

  const parsed =
    clientCursor && /^[0-9]+$/.test(clientCursor)
      ? Number.parseInt(clientCursor, 10)
      : null;
  if (parsed !== null && Number.isFinite(parsed)) {
    if (parsed >= current) {
      return String(parsed + 1);
    }
  }
  return String(current);
}

export class DurableStreamStore {
  #streams = new Map<string, StreamState>();

  ensureStream(key: string, contentType: string): DurableStreamRecord {
    const existing = this.#streams.get(key);
    if (existing) {
      if (existing.contentType !== contentType) {
        throw Object.assign(new Error("Stream already exists with different Content-Type"), {
          name: "DurableStreamConflictError",
        });
      }
      return this.getRecord(existing);
    }

    const createdAt = Date.now();
    const state: StreamState = {
      key,
      contentType,
      createdAt,
      entries: [],
      offsetCounter: 0,
      cursor: computeCursor(),
      waiters: new Set(),
    };
    this.#streams.set(key, state);
    return this.getRecord(state);
  }

  hasStream(key: string): boolean {
    return this.#streams.has(key);
  }

  getRecordByKey(key: string): DurableStreamRecord | null {
    const state = this.#streams.get(key);
    return state ? this.getRecord(state) : null;
  }

  deleteStream(key: string): boolean {
    const state = this.#streams.get(key);
    if (!state) return false;
    // Wake any long-poll waiters so they can observe deletion via subsequent request.
    for (const resolve of state.waiters) {
      resolve(null);
    }
    state.waiters.clear();
    return this.#streams.delete(key);
  }

  appendBytes(key: string, bytes: Uint8Array): DurableStreamRecord {
    const state = this.#streams.get(key);
    if (!state) {
      throw Object.assign(new Error("Stream not found"), {
        name: "DurableStreamNotFoundError",
      });
    }
    if (bytes.byteLength === 0) {
      throw Object.assign(new Error("Empty append"), {
        name: "DurableStreamBadRequestError",
      });
    }

    const startOffset = encodeOffset(state.offsetCounter);
    state.offsetCounter += 1;
    const endOffset = encodeOffset(state.offsetCounter);

    state.entries.push({
      startOffset,
      endOffset,
      bytes,
    });

    // Update cursor and wake waiters.
    state.cursor = computeCursor(state.cursor);
    for (const resolve of state.waiters) {
      resolve({ cursor: state.cursor });
    }
    state.waiters.clear();

    return this.getRecord(state);
  }

  /**
   * Read bytes starting at an offset.
   *
   * Semantics:
   * - `-1` is stream start.
   * - `now` is current tail (no data returned).
   * - For server-generated offsets, we treat them as "after N appends" where N is the decoded counter.
   */
  readBytes(key: string, offset: string | null | undefined): {
    bytes: Uint8Array;
    nextOffset: DurableStreamOffset;
    upToDate: boolean;
    cursor: string;
  } {
    const state = this.#streams.get(key);
    if (!state) {
      throw Object.assign(new Error("Stream not found"), {
        name: "DurableStreamNotFoundError",
      });
    }

    if (!offset || offset === "-1") {
      return {
        bytes: concatBytes(state.entries.map((e) => e.bytes)),
        nextOffset: encodeOffset(state.offsetCounter),
        upToDate: true,
        cursor: state.cursor,
      };
    }

    if (offset === "now") {
      return {
        bytes: new Uint8Array(),
        nextOffset: encodeOffset(state.offsetCounter),
        upToDate: true,
        cursor: state.cursor,
      };
    }

    const n = parseOffset(offset);
    if (n === null) {
      throw Object.assign(new Error("Invalid offset"), {
        name: "DurableStreamBadRequestError",
      });
    }

    // n is "after n appends", so read from entry index n onwards.
    const slice = state.entries.slice(n);
    return {
      bytes: concatBytes(slice.map((e) => e.bytes)),
      nextOffset: encodeOffset(state.offsetCounter),
      upToDate: true,
      cursor: state.cursor,
    };
  }

  async waitForAppend(key: string, timeoutMs: number): Promise<{ cursor: string } | null> {
    const state = this.#streams.get(key);
    if (!state) {
      throw Object.assign(new Error("Stream not found"), {
        name: "DurableStreamNotFoundError",
      });
    }

    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        state.waiters.delete(resolve);
        resolve(null);
      }, timeoutMs);

      state.waiters.add((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }

  private getRecord(state: StreamState): DurableStreamRecord {
    return {
      key: state.key,
      contentType: state.contentType,
      createdAt: state.createdAt,
      nextOffset: encodeOffset(state.offsetCounter),
      cursor: state.cursor,
    };
  }
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array();
  if (chunks.length === 1) return chunks[0];
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

