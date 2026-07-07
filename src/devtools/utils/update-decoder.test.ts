import { describe, expect, it } from "bun:test";
import type { VersionedUpdate } from "teleportal";
import * as Y from "yjs";
import { decodeUpdateOps, formatUpdateOp } from "./update-decoder";

function v1(data: Uint8Array): VersionedUpdate {
  return { version: 1, data } as VersionedUpdate;
}

function v2(data: Uint8Array): VersionedUpdate {
  return { version: 2, data } as VersionedUpdate;
}

describe("decodeUpdateOps", () => {
  it("decodes a text insert with content, id, and root parent", () => {
    const doc = new Y.Doc();
    const clientId = doc.clientID;
    const update = Y.encodeStateAsUpdate(doc);
    doc.getText("body").insert(0, "hello");
    const textUpdate = Y.encodeStateAsUpdate(doc, Y.encodeStateVector(new Y.Doc()));

    const decoded = decodeUpdateOps(v1(textUpdate));
    expect(decoded.insertCount).toBe(1);
    expect(decoded.insertedLength).toBe(5);
    expect(decoded.deleteCount).toBe(0);

    const op = decoded.ops[0];
    expect(op.kind).toBe("insert");
    expect(op.client).toBe(clientId);
    expect(op.contentType).toBe("text");
    expect(op.preview).toBe('"hello"');
    expect(op.parent).toBe("body");
    expect(update.length).toBeGreaterThan(0);
  });

  it("decodes map sets with the key name", () => {
    const doc = new Y.Doc();
    doc.getMap("meta").set("title", "Draft");
    const update = Y.encodeStateAsUpdate(doc);

    const decoded = decodeUpdateOps(v1(update));
    const op = decoded.ops.find((o) => o.kind === "insert")!;
    expect(op.key).toBe("title");
    expect(op.contentType).toBe("value");
    expect(op.preview).toBe('"Draft"');
    expect(op.parent).toBe("meta");
  });

  it("decodes deletes as delete-set ranges", () => {
    const doc = new Y.Doc();
    const text = doc.getText("body");
    text.insert(0, "hello world");
    const before = Y.encodeStateVector(doc);
    doc.transact(() => {
      text.delete(0, 6);
    });
    const update = Y.encodeStateAsUpdate(doc, before);

    const decoded = decodeUpdateOps(v1(update));
    expect(decoded.deleteCount).toBeGreaterThan(0);
    expect(decoded.deletedLength).toBe(6);
    const del = decoded.ops.find((o) => o.kind === "delete")!;
    expect(del.length).toBe(6);
  });

  it("reports an origin for mid-sequence inserts instead of a parent", () => {
    const doc = new Y.Doc();
    const text = doc.getText("body");
    text.insert(0, "ab");
    const before = Y.encodeStateVector(doc);
    text.insert(1, "X");
    const update = Y.encodeStateAsUpdate(doc, before);

    const decoded = decodeUpdateOps(v1(update));
    const op = decoded.ops.find((o) => o.kind === "insert")!;
    expect(op.origin).toEqual({ client: doc.clientID, clock: 0 });
  });

  it("decodes shared type creation", () => {
    const doc = new Y.Doc();
    const map = doc.getMap("root");
    map.set("nested", new Y.Array());
    const update = Y.encodeStateAsUpdate(doc);

    const decoded = decodeUpdateOps(v1(update));
    const op = decoded.ops.find((o) => o.contentType === "type")!;
    expect(op.preview).toBe("YArray");
    expect(op.key).toBe("nested");
  });

  it("decodes V2 updates", () => {
    const doc = new Y.Doc();
    doc.getText("body").insert(0, "v2!");
    const update = Y.encodeStateAsUpdateV2(doc);

    const decoded = decodeUpdateOps(v2(update));
    expect(decoded.insertCount).toBe(1);
    expect(decoded.ops[0].preview).toBe('"v2!"');
  });
});

describe("formatUpdateOp", () => {
  it("renders inserts, sets, and deletes as readable lines", () => {
    const doc = new Y.Doc();
    doc.getText("body").insert(0, "hi");
    doc.getMap("meta").set("title", "Draft");
    const update = Y.encodeStateAsUpdate(doc);

    const lines = decodeUpdateOps(v1(update)).ops.map(formatUpdateOp);
    expect(lines.some((l) => l.includes('insert "hi"') && l.includes("in body"))).toBe(true);
    expect(lines.some((l) => l.includes('set title = "Draft"') && l.includes("in meta"))).toBe(
      true,
    );
  });
});
