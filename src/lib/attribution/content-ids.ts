/**
 * IdSet and ContentIds — reimplemented from Y.js v14 (src/utils/ids.js).
 *
 * An IdSet is a compact representation of Y.js CRDT operation IDs.
 * Each operation in Y.js has a unique ID = (clientID, clock).
 * An IdSet stores ranges of (clientID, clock, length) per client,
 * representing contiguous runs of operations.
 *
 * ContentIds = { inserts: IdSet, deletes: IdSet } — the full set of
 * operations in a Y.js update, split by insert vs delete.
 */

export class IdRange {
  constructor(
    public clock: number,
    public len: number,
  ) {}
}

export class IdRanges {
  private _ids: IdRange[];
  private _sorted = false;

  constructor(ids: IdRange[] = []) {
    this._ids = ids;
    this._sorted = ids.length <= 1;
  }

  add(clock: number, length: number) {
    const ids = this._ids;
    if (ids.length > 0) {
      const last = ids.at(-1)!;
      if (last.clock + last.len === clock) {
        last.len += length;
        return;
      }
    }
    ids.push(new IdRange(clock, length));
    this._sorted = false;
  }

  getIds(): IdRange[] {
    if (!this._sorted) {
      this._ids.sort((a, b) => a.clock - b.clock);
      const merged: IdRange[] = [];
      for (const range of this._ids) {
        if (merged.length > 0) {
          const last = merged.at(-1)!;
          if (last.clock + last.len >= range.clock) {
            last.len = Math.max(last.len, range.clock + range.len - last.clock);
            continue;
          }
        }
        merged.push(new IdRange(range.clock, range.len));
      }
      this._ids = merged;
      this._sorted = true;
    }
    return this._ids;
  }

  copy(): IdRanges {
    return new IdRanges(
      this.getIds().map((r) => new IdRange(r.clock, r.len)),
    );
  }
}

/**
 * Binary search for the index of the range containing `clock`,
 * or the insertion point if not found.
 */
function findIndexInIdRanges(ids: IdRange[], clock: number): number {
  let lo = 0;
  let hi = ids.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const range = ids[mid];
    if (clock < range.clock) {
      hi = mid - 1;
    } else if (clock >= range.clock + range.len) {
      lo = mid + 1;
    } else {
      return mid;
    }
  }
  return -1;
}

export interface MaybeIdRange {
  clock: number;
  len: number;
  exists: boolean;
}

export class IdSet {
  clients: Map<number, IdRanges> = new Map();

  isEmpty(): boolean {
    if (this.clients.size === 0) return true;
    for (const ranges of this.clients.values()) {
      if (ranges.getIds().length > 0) return false;
    }
    return true;
  }

  add(client: number, clock: number, len: number) {
    let ranges = this.clients.get(client);
    if (!ranges) {
      ranges = new IdRanges();
      this.clients.set(client, ranges);
    }
    ranges.add(clock, len);
  }

  has(client: number, clock: number): boolean {
    const ranges = this.clients.get(client);
    if (!ranges) return false;
    return findIndexInIdRanges(ranges.getIds(), clock) >= 0;
  }

  /**
   * Returns which portions of [clock, clock+len) exist in this set.
   * Each MaybeIdRange indicates a sub-range and whether it exists.
   */
  slice(client: number, clock: number, len: number): MaybeIdRange[] {
    const ranges = this.clients.get(client);
    if (!ranges) {
      return [{ clock, len, exists: false }];
    }
    const ids = ranges.getIds();
    const result: MaybeIdRange[] = [];
    let pos = clock;
    const end = clock + len;

    for (const range of ids) {
      if (range.clock >= end) break;
      const rangeEnd = range.clock + range.len;
      if (rangeEnd <= pos) continue;

      // Gap before this range
      if (pos < range.clock) {
        const gapEnd = Math.min(range.clock, end);
        result.push({ clock: pos, len: gapEnd - pos, exists: false });
        pos = gapEnd;
      }

      // Overlap with this range
      if (pos < end && pos < rangeEnd) {
        const overlapEnd = Math.min(rangeEnd, end);
        result.push({ clock: pos, len: overlapEnd - pos, exists: true });
        pos = overlapEnd;
      }
    }

    // Trailing gap
    if (pos < end) {
      result.push({ clock: pos, len: end - pos, exists: false });
    }

    return result;
  }

  forEach(f: (client: number, clock: number, len: number) => void) {
    for (const [client, ranges] of this.clients.entries()) {
      for (const range of ranges.getIds()) {
        f(client, range.clock, range.len);
      }
    }
  }

  delete(client: number, clock: number, len: number) {
    const ranges = this.clients.get(client);
    if (!ranges) return;
    deleteRangeFromRanges(ranges, clock, len);
  }
}

function deleteRangeFromRanges(ranges: IdRanges, clock: number, len: number) {
  const ids = ranges.getIds();
  const end = clock + len;
  const newIds: IdRange[] = [];

  for (const range of ids) {
    const rangeEnd = range.clock + range.len;
    if (rangeEnd <= clock || range.clock >= end) {
      // No overlap
      newIds.push(range);
    } else {
      // Left remainder
      if (range.clock < clock) {
        newIds.push(new IdRange(range.clock, clock - range.clock));
      }
      // Right remainder
      if (rangeEnd > end) {
        newIds.push(new IdRange(end, rangeEnd - end));
      }
    }
  }

  // Replace the internal array (rebuild IdRanges)
  const replacement = new IdRanges(newIds);
  replacement.getIds(); // ensure sorted
  // Copy back
  Object.assign(ranges, replacement);
}

// --- Set operations ---

export function mergeIdSets(sets: IdSet[]): IdSet {
  const merged = new IdSet();
  for (const set of sets) {
    for (const [client, ranges] of set.clients.entries()) {
      for (const range of ranges.getIds()) {
        merged.add(client, range.clock, range.len);
      }
    }
  }
  return merged;
}

export function diffIdSet(set: IdSet, exclude: IdSet): IdSet {
  const result = new IdSet();
  for (const [client, ranges] of set.clients.entries()) {
    for (const range of ranges.getIds()) {
      const slices = exclude.slice(client, range.clock, range.len);
      for (const s of slices) {
        if (!s.exists) {
          result.add(client, s.clock, s.len);
        }
      }
    }
  }
  return result;
}

export function intersectIdSets(a: IdSet, b: IdSet): IdSet {
  const result = new IdSet();
  for (const [client, ranges] of a.clients.entries()) {
    for (const range of ranges.getIds()) {
      const slices = b.slice(client, range.clock, range.len);
      for (const s of slices) {
        if (s.exists) {
          result.add(client, s.clock, s.len);
        }
      }
    }
  }
  return result;
}

// --- ContentIds ---

export interface ContentIds {
  inserts: IdSet;
  deletes: IdSet;
}

export function createContentIds(
  inserts?: IdSet,
  deletes?: IdSet,
): ContentIds {
  return {
    inserts: inserts ?? new IdSet(),
    deletes: deletes ?? new IdSet(),
  };
}

export function mergeContentIds(ids: ContentIds[]): ContentIds {
  return {
    inserts: mergeIdSets(ids.map((c) => c.inserts)),
    deletes: mergeIdSets(ids.map((c) => c.deletes)),
  };
}

export function excludeContentIds(
  content: ContentIds,
  exclude: ContentIds,
): ContentIds {
  return {
    inserts: diffIdSet(content.inserts, exclude.inserts),
    deletes: diffIdSet(content.deletes, exclude.deletes),
  };
}

export function intersectContentIds(a: ContentIds, b: ContentIds): ContentIds {
  return {
    inserts: intersectIdSets(a.inserts, b.inserts),
    deletes: intersectIdSets(a.deletes, b.deletes),
  };
}
