import type { VersionedUpdate } from "teleportal";
import { decodeUpdateVersioned } from "teleportal/protocol";
import * as Y from "yjs";

/**
 * A single concrete operation carried by a Y.js update, in terms a human can
 * read: what happened, where, and which CRDT id range it covers.
 */
export type UpdateOp = {
  kind: "insert" | "delete" | "gc" | "skip";
  client: number;
  clock: number;
  length: number;
  /**
   * What was inserted, for inserts: "text", "value", "format", "embed",
   * "type", "binary", "subdoc", "deleted".
   */
  contentType?: string;
  /** Root type name when the item's parent is a named root (e.g. "prosemirror"). */
  parent?: string;
  /** Map key for YMap sets / attribute name. */
  key?: string;
  /** The (client, clock) this item attaches after, when known. */
  origin?: { client: number; clock: number };
  /** Human-readable rendering of the inserted content. */
  preview?: string;
};

export type DecodedUpdateOps = {
  ops: UpdateOp[];
  insertCount: number;
  insertedLength: number;
  deleteCount: number;
  deletedLength: number;
};

const PREVIEW_LIMIT = 200;

function truncate(text: string): string {
  return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}…` : text;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function describeContent(content: Y.Item["content"]): { contentType: string; preview: string } {
  if (content instanceof Y.ContentString) {
    return { contentType: "text", preview: truncate(JSON.stringify(content.str)) };
  }
  if (content instanceof Y.ContentAny) {
    const values = content.arr;
    const rendered = values.length === 1 ? safeStringify(values[0]) : safeStringify(values);
    return { contentType: "value", preview: truncate(rendered) };
  }
  if (content instanceof Y.ContentJSON) {
    return { contentType: "value", preview: truncate(safeStringify(content.arr)) };
  }
  if (content instanceof Y.ContentFormat) {
    return {
      contentType: "format",
      preview: truncate(`${content.key} = ${safeStringify(content.value)}`),
    };
  }
  if (content instanceof Y.ContentEmbed) {
    return { contentType: "embed", preview: truncate(safeStringify(content.embed)) };
  }
  if (content instanceof Y.ContentType) {
    const typeName = content.type?.constructor?.name ?? "AbstractType";
    return { contentType: "type", preview: typeName };
  }
  if (content instanceof Y.ContentBinary) {
    const bytes = (content as unknown as { content: Uint8Array }).content;
    return { contentType: "binary", preview: `${bytes?.byteLength ?? 0} bytes` };
  }
  if (content instanceof Y.ContentDoc) {
    return { contentType: "subdoc", preview: content.doc?.guid ?? "unknown" };
  }
  if (content instanceof Y.ContentDeleted) {
    return { contentType: "deleted", preview: `${content.getLength()} items` };
  }
  return { contentType: "unknown", preview: "" };
}

/**
 * Decodes a Y.js update into the concrete ops it applies — inserts with
 * their content and location, plus delete-set ranges. Works on decoded
 * (un-integrated) structs, so `parent` is only available when the item
 * attaches directly to a named root; otherwise the origin id is reported.
 */
export function decodeUpdateOps(update: VersionedUpdate): DecodedUpdateOps {
  const { structs, ds } = decodeUpdateVersioned(update);

  const ops: UpdateOp[] = [];
  let insertCount = 0;
  let insertedLength = 0;

  for (const struct of structs) {
    if (struct instanceof Y.Item) {
      const { contentType, preview } = describeContent(struct.content);
      const op: UpdateOp = {
        kind: "insert",
        client: struct.id.client,
        clock: struct.id.clock,
        length: struct.length,
        contentType,
        preview,
      };
      if (typeof struct.parent === "string") {
        op.parent = struct.parent;
      }
      if (struct.parentSub) {
        op.key = struct.parentSub;
      }
      if (struct.origin) {
        op.origin = { client: struct.origin.client, clock: struct.origin.clock };
      }
      ops.push(op);
      insertCount++;
      insertedLength += struct.length;
    } else if (struct instanceof Y.GC) {
      ops.push({
        kind: "gc",
        client: struct.id.client,
        clock: struct.id.clock,
        length: struct.length,
      });
    } else if (struct instanceof Y.Skip) {
      ops.push({
        kind: "skip",
        client: struct.id.client,
        clock: struct.id.clock,
        length: struct.length,
      });
    }
  }

  let deleteCount = 0;
  let deletedLength = 0;
  for (const [client, items] of ds.clients) {
    for (const item of items) {
      ops.push({
        kind: "delete",
        client,
        clock: item.clock,
        length: item.len,
      });
      deleteCount++;
      deletedLength += item.len;
    }
  }

  return { ops, insertCount, insertedLength, deleteCount, deletedLength };
}

/** One-line rendering of an op, used by the inspector and copyable logs. */
export function formatUpdateOp(op: UpdateOp): string {
  const id = `(${op.client}, ${op.clock})`;
  switch (op.kind) {
    case "insert": {
      const location = op.parent
        ? `${op.parent}${op.key ? `.${op.key}` : ""}`
        : op.origin
          ? `after (${op.origin.client}, ${op.origin.clock})`
          : op.key
            ? `.${op.key}`
            : "";
      const what =
        op.contentType === "text"
          ? `insert ${op.preview}`
          : op.contentType === "value"
            ? `set ${op.key ? `${op.key} = ` : ""}${op.preview}`
            : op.contentType === "format"
              ? `format ${op.preview}`
              : op.contentType === "type"
                ? `create ${op.preview}${op.key ? ` as ${op.key}` : ""}`
                : op.contentType === "deleted"
                  ? `insert deleted range (${op.preview})`
                  : `insert ${op.contentType} ${op.preview}`;
      return `+ ${what} @ ${id}${location ? ` in ${location}` : ""}`;
    }
    case "delete":
      return `− delete ${op.length} item${op.length === 1 ? "" : "s"} @ ${id}–${op.clock + op.length - 1}`;
    case "gc":
      return `· gc ${op.length} @ ${id}`;
    case "skip":
      return `· skip ${op.length} @ ${id}`;
  }
}
