import { describe, expect, it } from "bun:test";
import * as Y from "yjs";
import { stripContent, restoreContent, type Sidecar } from "./content-cipher";

/**
 * Regression tests for restoreContent's handling of an incomplete sidecar.
 *
 * The placeholder content written into the structure update for an encryptable
 * item (string / embed / binary / JSON / format / any / doc) is NOT a
 * length-prefixed integer. If restoreContent encounters such an item without a
 * matching sidecar entry, it must NOT fall back to readLen() — doing so would
 * misread the stream and silently corrupt the rest of the update. It should
 * throw instead so the caller (e.g. a server that over-filtered sidecars) finds
 * out loudly.
 */
describe("restoreContent with incomplete sidecar", () => {
  function stripDoc(fn: (doc: Y.Doc) => void): { structureUpdate: Uint8Array; sidecar: Sidecar } {
    const doc = new Y.Doc();
    fn(doc);
    const update = Y.encodeStateAsUpdateV2(doc);
    const { update: structureUpdate, sidecar } = stripContent(update, 2);
    return { structureUpdate, sidecar };
  }

  it("throws when a string item's sidecar entry is missing", () => {
    const { structureUpdate, sidecar } = stripDoc((doc) => {
      doc.getText("t").insert(0, "hello world");
    });

    expect(sidecar.entries.length).toBeGreaterThan(0);

    const stripped: Sidecar = { entries: [], dictionary: sidecar.dictionary };
    expect(() => restoreContent(structureUpdate, stripped, 2)).toThrow(
      /missing sidecar entry for encryptable content/,
    );
  });

  it("throws when only some of several entries are missing", () => {
    const { structureUpdate, sidecar } = stripDoc((doc) => {
      doc.getMap("m").set("k", "value");
      doc.getText("t").insert(0, "abc");
      doc.getArray("a").insert(0, [1, 2, 3]);
    });

    expect(sidecar.entries.length).toBeGreaterThan(1);

    // Drop the last entry only.
    const partial: Sidecar = {
      entries: sidecar.entries.slice(0, -1),
      dictionary: sidecar.dictionary,
    };
    expect(() => restoreContent(structureUpdate, partial, 2)).toThrow(
      /missing sidecar entry for encryptable content/,
    );
  });

  it("still restores correctly when the full sidecar is present", () => {
    const { structureUpdate, sidecar } = stripDoc((doc) => {
      doc.getText("t").insert(0, "hello world");
      doc.getMap("m").set("k", "v");
    });

    const restored = restoreContent(structureUpdate, sidecar, 2);
    const out = new Y.Doc();
    Y.applyUpdateV2(out, restored);
    expect(out.getText("t").toString()).toBe("hello world");
    expect(out.getMap("m").get("k")).toBe("v");
  });

  it("does not throw for documents with only non-encryptable content (deletes)", () => {
    // A doc whose only structure is a deletion produces no encryptable entries;
    // restoreContent with an empty sidecar must succeed.
    const doc = new Y.Doc();
    const text = doc.getText("t");
    text.insert(0, "abc");
    // Capture the delete-only update by diffing before/after.
    const before = Y.encodeStateVector(doc);
    text.delete(0, 3);
    const deleteUpdate = Y.encodeStateAsUpdateV2(doc, before);
    const { update: structureUpdate, sidecar } = stripContent(deleteUpdate, 2);

    // The delete update carries no encryptable content of its own beyond what
    // was already stripped; restoring with its own (possibly empty) sidecar
    // must not throw.
    expect(() => restoreContent(structureUpdate, sidecar, 2)).not.toThrow();
  });
});
