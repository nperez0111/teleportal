import { describe, expect, it } from "bun:test";
import * as Y from "yjs";
import {
  stripContent,
  restoreContent,
  gcSidecar,
  mergeSidecars,
  encodeSidecar,
  decodeSidecar,
  type Sidecar,
} from "./content-cipher";

function v1(doc: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(doc);
}

function v2(doc: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdateV2(doc);
}

describe("sidecar garbage collection", () => {
  describe("gcSidecar", () => {
    // ── Full GC: all content deleted ─────────────────────────────────────

    it("removes all entries when all text content has been GC'd", () => {
      const doc = new Y.Doc();
      doc.clientID = 1;
      doc.getText("t").insert(0, "Hello World");

      // Capture sidecar from initial state
      const { sidecar: initialSidecar } = stripContent(v1(doc), 1);
      expect(initialSidecar.entries.length).toBe(1);
      expect(initialSidecar.entries[0].clientId).toBe(1);

      // Delete all text → with gc=true, items become GC structs on re-encode
      doc.getText("t").delete(0, 11);

      // Re-encode full state → GC structs replace deleted items
      const { update: gcedStruct } = stripContent(v1(doc), 1);

      const result = gcSidecar(gcedStruct, initialSidecar);
      expect(result.entries.length).toBe(0);
    });

    it("removes all entries when map values have been deleted and GC'd", () => {
      const doc = new Y.Doc();
      doc.clientID = 1;
      const map = doc.getMap("m");
      map.set("key1", "value1");
      map.set("key2", "value2");

      const { sidecar: initialSidecar } = stripContent(v1(doc), 1);
      const initialCount = initialSidecar.entries.length;
      expect(initialCount).toBeGreaterThan(0);

      // Delete both keys
      map.delete("key1");
      map.delete("key2");

      const { update: gcedStruct } = stripContent(v1(doc), 1);
      const result = gcSidecar(gcedStruct, initialSidecar);

      // All content entries for the deleted values should be removed.
      // Note: the map.delete creates ContentDeleted items (contentRef=1) which
      // are NOT encryptable, so no new sidecar entries are created for them.
      // The old value items (contentRef=8, ContentAny) are GC'd.
      expect(result.entries.length).toBe(0);
    });

    // ── Partial GC: some content survives ────────────────────────────────

    it("keeps entries for alive items, removes entries for GC'd items", () => {
      // Use two clients so Y.js doesn't merge their items into one struct
      const docA = new Y.Doc();
      docA.clientID = 10;
      docA.getText("t").insert(0, "Hello");

      const docB = new Y.Doc();
      docB.clientID = 20;
      Y.applyUpdate(docB, v1(docA));
      docB.getText("t").insert(5, " World");

      // Merge into one doc
      const merged = new Y.Doc();
      Y.applyUpdate(merged, v1(docA));
      Y.applyUpdate(merged, v1(docB));

      const { sidecar: fullSidecar } = stripContent(v1(merged), 1);
      expect(fullSidecar.entries.filter((e) => e.clientId === 10).length).toBe(1);
      expect(fullSidecar.entries.filter((e) => e.clientId === 20).length).toBe(1);

      // Delete "Hello" (client 10's text at position 0)
      merged.getText("t").delete(0, 5);

      const { update: afterGcStruct } = stripContent(v1(merged), 1);

      const result = gcSidecar(afterGcStruct, fullSidecar);

      // Client 10's entry is GC'd, client 20's survives
      expect(result.entries.filter((e) => e.clientId === 10).length).toBe(0);
      expect(result.entries.filter((e) => e.clientId === 20).length).toBe(1);

      // The surviving entry should be restorable
      const restored = restoreContent(afterGcStruct, result, 2);
      const out = new Y.Doc();
      Y.applyUpdateV2(out, restored);
      expect(out.getText("t").toString()).toBe(" World");
    });

    it("keeps entries from one client, removes GC'd entries from another", () => {
      // Client A inserts "AAA"
      const docA = new Y.Doc();
      docA.clientID = 10;
      docA.getText("t").insert(0, "AAA");

      // Client B inserts "BBB" (after syncing A)
      const docB = new Y.Doc();
      docB.clientID = 20;
      Y.applyUpdate(docB, v1(docA));
      docB.getText("t").insert(3, "BBB");

      // Merge into a single doc
      const merged = new Y.Doc();
      Y.applyUpdate(merged, v1(docA));
      Y.applyUpdate(merged, v1(docB));

      // Get sidecar from full merged state
      const { sidecar: fullSidecar } = stripContent(v1(merged), 1);
      const clientAEntries = fullSidecar.entries.filter((e) => e.clientId === 10);
      const clientBEntries = fullSidecar.entries.filter((e) => e.clientId === 20);
      expect(clientAEntries.length).toBeGreaterThan(0);
      expect(clientBEntries.length).toBeGreaterThan(0);

      // Delete only client A's text
      merged.getText("t").delete(0, 3);

      // Re-encode → client A's items are GC'd
      const { update: afterGcStruct } = stripContent(v1(merged), 1);

      const result = gcSidecar(afterGcStruct, fullSidecar);

      // Client A entries removed, client B entries kept
      expect(result.entries.filter((e) => e.clientId === 10).length).toBe(0);
      expect(result.entries.filter((e) => e.clientId === 20).length).toBeGreaterThan(0);
    });

    // ── No GC: gc=false preserves all entries ────────────────────────────

    it("preserves all entries when doc has gc=false (items not garbage collected)", () => {
      const doc = new Y.Doc({ gc: false });
      doc.clientID = 1;
      doc.getText("t").insert(0, "Hello World");

      const { sidecar: initialSidecar } = stripContent(v1(doc), 1);
      expect(initialSidecar.entries.length).toBe(1);

      // Delete text — but gc=false means items keep their content type
      doc.getText("t").delete(0, 11);

      const { update: afterDeleteStruct } = stripContent(v1(doc), 1);

      const result = gcSidecar(afterDeleteStruct, initialSidecar);

      // With gc=false, deleted items still have their content type in the
      // struct section (not GC structs), so sidecar entries are preserved
      expect(result.entries.length).toBe(1);
    });

    // ── Edge cases ───────────────────────────────────────────────────────

    it("returns empty sidecar when input sidecar is empty", () => {
      const doc = new Y.Doc();
      doc.getText("t").insert(0, "Hello");
      const { update: structUpdate } = stripContent(v1(doc), 1);

      const emptySidecar: Sidecar = { entries: [], dictionary: new Map() };
      const result = gcSidecar(structUpdate, emptySidecar);
      expect(result.entries.length).toBe(0);
    });

    it("returns all entries when structure update has no GC structs", () => {
      const doc = new Y.Doc();
      doc.clientID = 1;
      doc.getText("t").insert(0, "Hello World");

      const { update: structUpdate, sidecar } = stripContent(v1(doc), 1);

      // No deletions → no GC → all entries should survive
      const result = gcSidecar(structUpdate, sidecar);
      expect(result.entries.length).toBe(sidecar.entries.length);
    });

    it("handles sidecar entries for array values", () => {
      const doc = new Y.Doc();
      doc.clientID = 1;
      doc.getArray("a").insert(0, ["item1", "item2", "item3"]);

      const { sidecar: initialSidecar } = stripContent(v1(doc), 1);
      expect(initialSidecar.entries.length).toBeGreaterThan(0);

      // Delete some array items
      doc.getArray("a").delete(0, 2);

      const { update: afterGcStruct } = stripContent(v1(doc), 1);

      const result = gcSidecar(afterGcStruct, initialSidecar);

      // Restoring with the GC'd sidecar should produce a valid doc
      const restored = restoreContent(afterGcStruct, result, 2);
      const out = new Y.Doc();
      Y.applyUpdateV2(out, restored);
      expect(out.getArray("a").toArray()).toEqual(["item3"]);
    });

    it("handles multiple rounds of insert-delete-GC", () => {
      const doc = new Y.Doc();
      doc.clientID = 1;

      // Round 1: insert
      doc.getText("t").insert(0, "Hello");
      const { sidecar: s1 } = stripContent(v1(doc), 1);

      // Round 2: insert more
      doc.getText("t").insert(5, " World");
      const { sidecar: s2 } = stripContent(v1(doc), 1);

      // Round 3: delete "Hello" and insert "Goodbye"
      doc.getText("t").delete(0, 5);
      doc.getText("t").insert(0, "Goodbye");
      const { sidecar: s3 } = stripContent(v1(doc), 1);

      // Merge all sidecars (simulates accumulation over time)
      const merged = mergeSidecars([s1, s2, s3]);

      // Get current structure update
      const { update: currentStruct } = stripContent(v1(doc), 1);

      const result = gcSidecar(currentStruct, merged);

      // Only alive entries should remain
      const restored = restoreContent(currentStruct, result, 2);
      const out = new Y.Doc();
      Y.applyUpdateV2(out, restored);
      expect(out.getText("t").toString()).toBe("Goodbye World");
    });

    // ── Byte-for-byte compatibility ──────────────────────────────────────

    it("GC'd sidecar produces byte-identical restore as full sidecar", () => {
      const doc = new Y.Doc();
      doc.clientID = 1;
      doc.getText("t").insert(0, "Hello");
      doc.getText("t").insert(5, " World");

      // Get full sidecar
      const { sidecar: fullSidecar } = stripContent(v1(doc), 1);

      // Delete "Hello"
      doc.getText("t").delete(0, 5);

      // Get structure update after GC
      const { update: afterGcStruct } = stripContent(v1(doc), 1);

      // GC the sidecar
      const gcedSidecar = gcSidecar(afterGcStruct, fullSidecar);

      // Both sidecars should produce identical restores
      const restoredFull = restoreContent(afterGcStruct, fullSidecar, 2);
      const restoredGced = restoreContent(afterGcStruct, gcedSidecar, 2);
      expect(Buffer.from(restoredGced)).toEqual(Buffer.from(restoredFull));
    });

    it("restoring from GC'd sidecar produces byte-identical doc to original", () => {
      const doc = new Y.Doc();
      doc.clientID = 1;
      doc.getText("t").insert(0, "Hello World");
      doc.getText("t").delete(0, 5); // Delete "Hello"

      // Build sidecar from BEFORE deletion (includes "Hello" entry)
      // Reset to get the full pre-delete sidecar
      const preDel = new Y.Doc();
      preDel.clientID = 1;
      preDel.getText("t").insert(0, "Hello World");
      const { sidecar: oldSidecar } = stripContent(v1(preDel), 1);

      // Structure update after GC
      const { update: afterGcStruct, sidecar: freshSidecar } = stripContent(v1(doc), 1);

      // GC the old sidecar
      const gcedSidecar = gcSidecar(afterGcStruct, oldSidecar);

      // Restore with GC'd sidecar and with fresh sidecar should be identical
      const restoredGc = restoreContent(afterGcStruct, gcedSidecar, 1);
      const restoredFresh = restoreContent(afterGcStruct, freshSidecar, 1);

      const outGc = new Y.Doc();
      Y.applyUpdate(outGc, restoredGc);
      const outFresh = new Y.Doc();
      Y.applyUpdate(outFresh, restoredFresh);

      expect(outGc.getText("t").toString()).toBe(" World");
      expect(outFresh.getText("t").toString()).toBe(" World");
      expect(Buffer.from(restoredGc)).toEqual(Buffer.from(restoredFresh));
    });

    // ── Multi-clock items (partial overlap) ──────────────────────────────

    it("keeps sidecar entry when only part of its clock range is GC'd", () => {
      // This tests the case where a single sidecar entry (e.g., a 10-char
      // string covering clocks 0-9) has a prefix GC'd. The entry must be
      // kept because restoreContent slices into it for the surviving suffix.
      const doc = new Y.Doc();
      doc.clientID = 1;
      doc.getText("t").insert(0, "HelloWorld");

      const { sidecar: fullSidecar } = stripContent(v1(doc), 1);
      // Single entry covering clocks 0-9
      expect(fullSidecar.entries.length).toBe(1);
      expect(fullSidecar.entries[0].itemLength).toBe(10);

      // Delete "Hello" (clocks 0-4)
      doc.getText("t").delete(0, 5);

      // After GC: GC struct at clocks 0-4, item at clocks 5-9
      const { update: afterGcStruct } = stripContent(v1(doc), 1);

      const result = gcSidecar(afterGcStruct, fullSidecar);

      // The entry should be KEPT because clocks 5-9 still reference it
      expect(result.entries.length).toBe(1);

      // And it should restore correctly
      const restored = restoreContent(afterGcStruct, result, 2);
      const out = new Y.Doc();
      Y.applyUpdateV2(out, restored);
      expect(out.getText("t").toString()).toBe("World");
    });

    it("removes sidecar entry when its entire clock range is GC'd", () => {
      // Use two clients to guarantee separate sidecar entries
      const docA = new Y.Doc();
      docA.clientID = 10;
      docA.getText("t").insert(0, "Hello");

      const docB = new Y.Doc();
      docB.clientID = 20;
      Y.applyUpdate(docB, v1(docA));
      docB.getText("t").insert(5, "World");

      const merged = new Y.Doc();
      Y.applyUpdate(merged, v1(docA));
      Y.applyUpdate(merged, v1(docB));

      const { sidecar: fullSidecar } = stripContent(v1(merged), 1);
      expect(fullSidecar.entries.length).toBe(2);

      // Delete "Hello" entirely (client 10's range)
      merged.getText("t").delete(0, 5);

      const { update: afterGcStruct } = stripContent(v1(merged), 1);

      const result = gcSidecar(afterGcStruct, fullSidecar);

      // Client 10's entry fully GC'd → removed, client 20's → kept
      expect(result.entries.length).toBe(1);
      expect(result.entries[0].clientId).toBe(20);
    });

    // ── V2 input ─────────────────────────────────────────────────────────

    it("works with V2 encoded updates", () => {
      const doc = new Y.Doc();
      doc.clientID = 1;
      doc.getText("t").insert(0, "Hello World");

      const { sidecar: initialSidecar } = stripContent(v2(doc), 2);
      expect(initialSidecar.entries.length).toBe(1);

      doc.getText("t").delete(0, 11);

      const { update: gcedStruct } = stripContent(v2(doc), 2);

      const result = gcSidecar(gcedStruct, initialSidecar);
      expect(result.entries.length).toBe(0);
    });

    // ── Sidecar encoding round-trip after GC ─────────────────────────────

    it("GC'd sidecar survives encode/decode round-trip", () => {
      const doc = new Y.Doc();
      doc.clientID = 1;
      doc.getText("t").insert(0, "Hello");
      doc.getText("t").insert(5, " World");

      const { sidecar: fullSidecar } = stripContent(v1(doc), 1);

      doc.getText("t").delete(0, 5);

      const { update: afterGcStruct } = stripContent(v1(doc), 1);
      const gcedSidecar = gcSidecar(afterGcStruct, fullSidecar);

      // Encode and decode the GC'd sidecar
      const encoded = encodeSidecar(gcedSidecar);
      const decoded = decodeSidecar(encoded);

      expect(decoded.entries.length).toBe(gcedSidecar.entries.length);
      expect(decoded.entries).toEqual(gcedSidecar.entries);

      // Still restores correctly after round-trip
      const restored = restoreContent(afterGcStruct, decoded, 2);
      const out = new Y.Doc();
      Y.applyUpdateV2(out, restored);
      expect(out.getText("t").toString()).toBe(" World");
    });

    // ── Dictionary preservation ──────────────────────────────────────────

    it("preserves the dictionary (tokens may still be in structure update metadata)", () => {
      const doc = new Y.Doc();
      doc.clientID = 1;
      const map = doc.getMap("m");
      map.set("keep-key", "keep-value");
      map.set("remove-key", "remove-value");

      const { sidecar: fullSidecar } = stripContent(v1(doc), 1);
      expect(fullSidecar.dictionary.size).toBeGreaterThan(0);

      map.delete("remove-key");

      const { update: afterGcStruct } = stripContent(v1(doc), 1);
      const result = gcSidecar(afterGcStruct, fullSidecar);

      // Dictionary should be preserved (tokens in the structure update metadata
      // reference it, and cleaning dictionary requires deeper analysis)
      expect(result.dictionary).toBe(fullSidecar.dictionary);
    });

    // ── ContentFormat entries ─────────────────────────────────────────────

    it("handles GC of format markers in text", () => {
      const doc = new Y.Doc();
      doc.clientID = 1;
      const text = doc.getText("t");
      text.insert(0, "Hello World");
      text.format(0, 5, { bold: true });

      const { sidecar: initialSidecar } = stripContent(v1(doc), 1);
      // Should have entries for: "Hello World" string + bold format markers
      expect(initialSidecar.entries.length).toBeGreaterThan(1);

      // Delete all text — format markers will also be GC'd
      text.delete(0, 11);

      const { update: afterGcStruct } = stripContent(v1(doc), 1);
      const result = gcSidecar(afterGcStruct, initialSidecar);

      // All entries should be removed
      expect(result.entries.length).toBe(0);
    });

    // ── ContentEmbed entries ─────────────────────────────────────────────

    it("handles GC of embed content", () => {
      const doc = new Y.Doc();
      doc.clientID = 1;
      doc.getText("t").insertEmbed(0, { image: "https://example.com/img.png" });

      const { sidecar: initialSidecar } = stripContent(v1(doc), 1);
      const embedEntries = initialSidecar.entries.filter((e) => e.contentRef === 5);
      expect(embedEntries.length).toBe(1);

      doc.getText("t").delete(0, 1);

      const { update: afterGcStruct } = stripContent(v1(doc), 1);
      const result = gcSidecar(afterGcStruct, initialSidecar);
      expect(result.entries.filter((e) => e.contentRef === 5).length).toBe(0);
    });

    // ── Integration: GC + restore produces valid Y.js update ─────────────

    it("GC'd sidecar + structure update produces a valid, applicable Y.js update", () => {
      const doc = new Y.Doc();
      doc.clientID = 1;
      doc.getText("t").insert(0, "Delete me");
      doc.getMap("m").set("keep", "this value");

      // Accumulate sidecar over multiple snapshots
      const { sidecar: snap1 } = stripContent(v1(doc), 1);

      doc.getText("t").delete(0, 9);

      const { update: finalStruct, sidecar: snap2 } = stripContent(v1(doc), 1);

      // Merge old and new sidecars
      const merged = mergeSidecars([snap1, snap2]);

      // GC the merged sidecar
      const gcedSidecar = gcSidecar(finalStruct, merged);

      // Restore and verify
      const restored = restoreContent(finalStruct, gcedSidecar, 2);
      const out = new Y.Doc();
      expect(() => Y.applyUpdateV2(out, restored)).not.toThrow();
      expect(out.getText("t").toString()).toBe("");
      expect(out.getMap("m").get("keep")).toBe("this value");
    });

    // ── Map value replacement (not just deletion) ────────────────────────

    it("GCs old map value when key is overwritten", () => {
      const doc = new Y.Doc();
      doc.clientID = 1;
      const map = doc.getMap("m");
      map.set("key", "original");

      const { sidecar: beforeOverwrite } = stripContent(v1(doc), 1);
      expect(beforeOverwrite.entries.length).toBeGreaterThan(0);

      // Overwrite the value — old item becomes deleted, then GC'd
      map.set("key", "replacement");

      const { update: afterOverwriteStruct } = stripContent(v1(doc), 1);

      // GC the pre-overwrite sidecar
      const result = gcSidecar(afterOverwriteStruct, beforeOverwrite);

      // The original "original" entry should be GC'd since the old item
      // is replaced by a GC struct
      // The new "replacement" entry is in afterOverwriteSidecar, not in beforeOverwrite
      // So result should have fewer entries (the GC'd "original" is removed)
      expect(result.entries.length).toBe(0);
    });

    // ── Idempotency ──────────────────────────────────────────────────────

    it("is idempotent: running GC twice produces the same result", () => {
      const doc = new Y.Doc();
      doc.clientID = 1;
      doc.getText("t").insert(0, "Hello World");

      const { sidecar: initialSidecar } = stripContent(v1(doc), 1);

      doc.getText("t").delete(0, 5);

      const { update: afterGcStruct } = stripContent(v1(doc), 1);

      const firstGc = gcSidecar(afterGcStruct, initialSidecar);
      const secondGc = gcSidecar(afterGcStruct, firstGc);

      expect(secondGc.entries.length).toBe(firstGc.entries.length);
      expect(secondGc.entries).toEqual(firstGc.entries);
    });

    // ── Nested types: children become actual GC structs ──────────────────

    it("GCs child sidecar entries when a nested type parent is deleted", () => {
      const doc = new Y.Doc();
      doc.clientID = 1;
      const arr = doc.getArray("a");
      const nestedMap = new Y.Map();
      arr.insert(0, [nestedMap]);
      nestedMap.set("key", "value");

      const { sidecar: initialSidecar } = stripContent(v1(doc), 1);
      expect(initialSidecar.entries.length).toBeGreaterThan(0);

      // Delete the array element (parent of nested map)
      // → children of the nested map become actual GC structs
      arr.delete(0, 1);

      const { update: afterGcStruct } = stripContent(v1(doc), 1);

      const result = gcSidecar(afterGcStruct, initialSidecar);

      // The nested map's "value" entry should be GC'd
      const restored = restoreContent(afterGcStruct, result, 2);
      const out = new Y.Doc();
      Y.applyUpdateV2(out, restored);
      expect(out.getArray("a").length).toBe(0);
    });
  });

  // ── Byte-for-byte GC round-trip fidelity ─────────────────────────────
  //
  // For each scenario, verify that restoring from a GC'd (pruned) sidecar
  // produces a byte-identical V1 update to restoring from the fresh sidecar
  // that stripContent generated from the same final state. This proves GC
  // discards only truly dead entries. Additionally, verify the resulting
  // document has the correct content and matching state vector.

  describe("byte-for-byte GC fidelity", () => {
    /**
     * Build an older "pre-delete" sidecar, merge it with the current sidecar,
     * GC against the current structure update, and verify:
     * 1. Restore from GC'd sidecar = byte-identical to restore from fresh sidecar
     * 2. The resulting doc matches the original doc's content
     * 3. State vectors match
     */
    function expectGcByteExact(
      doc: Y.Doc,
      preDeletionSidecar: Sidecar,
      expectedContent: (doc: Y.Doc) => void,
    ) {
      const originalUpdate = v1(doc);
      const { update: structUpdate, sidecar: freshSidecar } = stripContent(originalUpdate, 1);

      // Merge old + fresh sidecars and GC
      const merged = mergeSidecars([preDeletionSidecar, freshSidecar]);
      const gcedSidecar = gcSidecar(structUpdate, merged);

      // V1 restore from both sidecars
      const restoredFresh = restoreContent(structUpdate, freshSidecar, 1);
      const restoredGced = restoreContent(structUpdate, gcedSidecar, 1);

      // Byte-exact update comparison
      expect(Buffer.from(restoredGced).equals(Buffer.from(restoredFresh))).toBe(true);

      // Byte-exact with original V1 update
      expect(Buffer.from(restoredGced).equals(Buffer.from(originalUpdate))).toBe(true);

      // Apply to fresh docs and verify content + state vector
      const outGc = new Y.Doc();
      Y.applyUpdate(outGc, restoredGced);
      const outRef = new Y.Doc();
      Y.applyUpdate(outRef, originalUpdate);

      expect(Y.encodeStateVector(outGc)).toEqual(Y.encodeStateVector(outRef));
      expectedContent(outGc);
    }

    // ── YText operations ─────────────────────────────────────────────────

    it("byte-exact: text insert + partial delete", () => {
      const doc = new Y.Doc();
      doc.clientID = 1;
      doc.getText("t").insert(0, "Hello World");
      const { sidecar: preSidecar } = stripContent(v1(doc), 1);

      doc.getText("t").delete(0, 6); // Delete "Hello "

      expectGcByteExact(doc, preSidecar, (d) => {
        expect(d.getText("t").toString()).toBe("World");
      });
    });

    it("byte-exact: text insert + full delete", () => {
      const doc = new Y.Doc();
      doc.clientID = 1;
      doc.getText("t").insert(0, "Temporary text");
      const { sidecar: preSidecar } = stripContent(v1(doc), 1);

      doc.getText("t").delete(0, 14);

      expectGcByteExact(doc, preSidecar, (d) => {
        expect(d.getText("t").toString()).toBe("");
      });
    });

    it("byte-exact: text replace (delete + insert)", () => {
      const doc = new Y.Doc();
      doc.clientID = 1;
      doc.getText("t").insert(0, "Hello World");
      const { sidecar: preSidecar } = stripContent(v1(doc), 1);

      doc.getText("t").delete(0, 5);
      doc.getText("t").insert(0, "Goodbye");

      expectGcByteExact(doc, preSidecar, (d) => {
        expect(d.getText("t").toString()).toBe("Goodbye World");
      });
    });

    it("byte-exact: text delete at end", () => {
      const doc = new Y.Doc();
      doc.clientID = 1;
      doc.getText("t").insert(0, "Hello World");
      const { sidecar: preSidecar } = stripContent(v1(doc), 1);

      doc.getText("t").delete(5, 6); // Delete " World"

      expectGcByteExact(doc, preSidecar, (d) => {
        expect(d.getText("t").toString()).toBe("Hello");
      });
    });

    it("byte-exact: text delete in middle", () => {
      const doc = new Y.Doc();
      doc.clientID = 1;
      doc.getText("t").insert(0, "Hello Beautiful World");
      const { sidecar: preSidecar } = stripContent(v1(doc), 1);

      doc.getText("t").delete(5, 10); // Delete " Beautiful"

      expectGcByteExact(doc, preSidecar, (d) => {
        expect(d.getText("t").toString()).toBe("Hello World");
      });
    });

    // ── YText with formatting ────────────────────────────────────────────

    it("byte-exact: formatted text partially deleted", () => {
      const doc = new Y.Doc();
      doc.clientID = 1;
      doc.getText("t").insert(0, "Hello World");
      doc.getText("t").format(0, 5, { bold: true });
      const { sidecar: preSidecar } = stripContent(v1(doc), 1);

      doc.getText("t").delete(0, 6); // Delete "Hello " (includes bold range)

      expectGcByteExact(doc, preSidecar, (d) => {
        expect(d.getText("t").toString()).toBe("World");
      });
    });

    it("byte-exact: formatting removed then text deleted", () => {
      const doc = new Y.Doc();
      doc.clientID = 1;
      doc.getText("t").insert(0, "Hello World");
      doc.getText("t").format(0, 5, { bold: true });
      doc.getText("t").format(0, 5, { bold: null });
      const { sidecar: preSidecar } = stripContent(v1(doc), 1);

      doc.getText("t").delete(0, 11);

      expectGcByteExact(doc, preSidecar, (d) => {
        expect(d.getText("t").toString()).toBe("");
      });
    });

    it("byte-exact: multiple format attributes with partial delete", () => {
      const doc = new Y.Doc();
      doc.clientID = 1;
      const text = doc.getText("t");
      text.insert(0, "Hello World");
      text.format(0, 5, { bold: true, color: "#ff0000" });
      text.format(6, 5, { italic: true });
      const { sidecar: preSidecar } = stripContent(v1(doc), 1);

      text.delete(0, 6); // Delete "Hello "

      expectGcByteExact(doc, preSidecar, (d) => {
        const delta = d.getText("t").toDelta();
        expect(delta).toEqual([{ insert: "World", attributes: { italic: true } }]);
      });
    });

    // ── YText with embeds ────────────────────────────────────────────────

    it("byte-exact: embed deleted", () => {
      const doc = new Y.Doc();
      doc.clientID = 1;
      doc.getText("t").insert(0, "before");
      doc.getText("t").insertEmbed(6, { image: "https://example.com/img.png", width: 200 });
      doc.getText("t").insert(7, "after");
      const { sidecar: preSidecar } = stripContent(v1(doc), 1);

      doc.getText("t").delete(6, 1); // Delete the embed

      expectGcByteExact(doc, preSidecar, (d) => {
        expect(d.getText("t").toString()).toBe("beforeafter");
      });
    });

    // ── YMap operations ──────────────────────────────────────────────────

    it("byte-exact: map key deleted", () => {
      const doc = new Y.Doc();
      doc.clientID = 1;
      const map = doc.getMap("m");
      map.set("keep", "yes");
      map.set("remove", "bye");
      const { sidecar: preSidecar } = stripContent(v1(doc), 1);

      map.delete("remove");

      expectGcByteExact(doc, preSidecar, (d) => {
        expect(d.getMap("m").get("keep")).toBe("yes");
        expect(d.getMap("m").get("remove")).toBeUndefined();
      });
    });

    it("byte-exact: map value overwritten", () => {
      const doc = new Y.Doc();
      doc.clientID = 1;
      const map = doc.getMap("m");
      map.set("key", "original");
      const { sidecar: preSidecar } = stripContent(v1(doc), 1);

      map.set("key", "replacement");

      expectGcByteExact(doc, preSidecar, (d) => {
        expect(d.getMap("m").get("key")).toBe("replacement");
      });
    });

    it("byte-exact: map with mixed value types, some deleted", () => {
      const doc = new Y.Doc();
      doc.clientID = 1;
      const map = doc.getMap("m");
      map.set("str", "hello");
      map.set("num", 42);
      map.set("bool", true);
      map.set("arr", [1, 2, 3]);
      map.set("obj", { nested: true });
      const { sidecar: preSidecar } = stripContent(v1(doc), 1);

      map.delete("str");
      map.delete("arr");
      map.set("num", 99); // overwrite

      expectGcByteExact(doc, preSidecar, (d) => {
        const m = d.getMap("m");
        expect(m.get("str")).toBeUndefined();
        expect(m.get("num")).toBe(99);
        expect(m.get("bool")).toBe(true);
        expect(m.get("arr")).toBeUndefined();
        expect(m.get("obj")).toEqual({ nested: true });
      });
    });

    // ── YArray operations ────────────────────────────────────────────────

    it("byte-exact: array elements deleted", () => {
      const doc = new Y.Doc();
      doc.clientID = 1;
      doc.getArray("a").insert(0, ["a", "b", "c", "d", "e"]);
      const { sidecar: preSidecar } = stripContent(v1(doc), 1);

      doc.getArray("a").delete(1, 3); // Delete "b", "c", "d"

      expectGcByteExact(doc, preSidecar, (d) => {
        expect(d.getArray("a").toArray()).toEqual(["a", "e"]);
      });
    });

    it("byte-exact: array splice (delete + insert)", () => {
      const doc = new Y.Doc();
      doc.clientID = 1;
      doc.getArray("a").insert(0, [1, 2, 3, 4, 5]);
      const { sidecar: preSidecar } = stripContent(v1(doc), 1);

      doc.getArray("a").delete(1, 3);
      doc.getArray("a").insert(1, [20, 30]);

      expectGcByteExact(doc, preSidecar, (d) => {
        expect(d.getArray("a").toArray()).toEqual([1, 20, 30, 5]);
      });
    });

    // ── Nested shared types (children become actual GC structs) ──────────

    it("byte-exact: nested map in array, parent deleted", () => {
      const doc = new Y.Doc();
      doc.clientID = 1;
      const arr = doc.getArray("a");
      const nested = new Y.Map();
      arr.insert(0, [nested]);
      nested.set("deep", "value");
      nested.set("deeper", "more");
      const { sidecar: preSidecar } = stripContent(v1(doc), 1);

      arr.delete(0, 1); // Delete the nested map (children become GC structs)

      expectGcByteExact(doc, preSidecar, (d) => {
        expect(d.getArray("a").length).toBe(0);
      });
    });

    it("byte-exact: nested text in map, parent key deleted", () => {
      const doc = new Y.Doc();
      doc.clientID = 1;
      const map = doc.getMap("m");
      const nestedText = new Y.Text("Secret content");
      map.set("content", nestedText);
      const { sidecar: preSidecar } = stripContent(v1(doc), 1);

      map.delete("content"); // Delete the nested text

      expectGcByteExact(doc, preSidecar, (d) => {
        expect(d.getMap("m").get("content")).toBeUndefined();
      });
    });

    it("byte-exact: deeply nested types, root deleted", () => {
      const doc = new Y.Doc();
      doc.clientID = 1;
      const arr = doc.getArray("a");
      const outerMap = new Y.Map();
      arr.insert(0, [outerMap]);
      const innerArr = new Y.Array();
      outerMap.set("items", innerArr);
      innerArr.insert(0, [new Y.Text("deep text")]);
      const { sidecar: preSidecar } = stripContent(v1(doc), 1);

      arr.delete(0, 1); // Delete root → all children become GC structs

      expectGcByteExact(doc, preSidecar, (d) => {
        expect(d.getArray("a").length).toBe(0);
      });
    });

    // ── XML operations ───────────────────────────────────────────────────

    it("byte-exact: xml element deleted with attributes", () => {
      const doc = new Y.Doc();
      doc.clientID = 1;
      const frag = doc.getXmlFragment("xml");
      const el = new Y.XmlElement("div");
      frag.insert(0, [el]);
      el.setAttribute("class", "container");
      el.setAttribute("id", "main");
      const span = new Y.XmlElement("span");
      el.insert(0, [span]);
      span.insert(0, [new Y.XmlText("hello world")]);
      const { sidecar: preSidecar } = stripContent(v1(doc), 1);

      frag.delete(0, 1); // Delete the div (children become GC structs)

      expectGcByteExact(doc, preSidecar, (d) => {
        expect(d.getXmlFragment("xml").length).toBe(0);
      });
    });

    it("byte-exact: xml attribute overwritten then element deleted", () => {
      const doc = new Y.Doc();
      doc.clientID = 1;
      const frag = doc.getXmlFragment("xml");
      const el = new Y.XmlElement("div");
      frag.insert(0, [el]);
      el.setAttribute("style", "color: red");
      el.setAttribute("style", "color: blue");
      const { sidecar: preSidecar } = stripContent(v1(doc), 1);

      frag.delete(0, 1);

      expectGcByteExact(doc, preSidecar, (d) => {
        expect(d.getXmlFragment("xml").length).toBe(0);
      });
    });

    // ── Subdoc ───────────────────────────────────────────────────────────

    it("byte-exact: subdoc deleted from map", () => {
      const doc = new Y.Doc();
      doc.clientID = 1;
      const subdoc = new Y.Doc({ guid: "child-1" });
      doc.getMap("docs").set("child", subdoc);
      const { sidecar: preSidecar } = stripContent(v1(doc), 1);

      doc.getMap("docs").delete("child");

      expectGcByteExact(doc, preSidecar, (d) => {
        expect(d.getMap("docs").get("child")).toBeUndefined();
      });
    });

    // ── Multi-client ─────────────────────────────────────────────────────

    it("byte-exact: two clients, one's content fully deleted", () => {
      const docA = new Y.Doc();
      docA.clientID = 10;
      docA.getText("t").insert(0, "AAA");

      const docB = new Y.Doc();
      docB.clientID = 20;
      Y.applyUpdate(docB, v1(docA));
      docB.getText("t").insert(3, "BBB");

      const merged = new Y.Doc();
      Y.applyUpdate(merged, v1(docA));
      Y.applyUpdate(merged, v1(docB));

      const { sidecar: preSidecar } = stripContent(v1(merged), 1);

      // Delete client A's text
      merged.getText("t").delete(0, 3);

      expectGcByteExact(merged, preSidecar, (d) => {
        expect(d.getText("t").toString()).toBe("BBB");
      });
    });

    it("byte-exact: three clients, middle one's content deleted", () => {
      const docA = new Y.Doc();
      docA.clientID = 10;
      docA.getText("t").insert(0, "AAA");

      const docB = new Y.Doc();
      docB.clientID = 20;
      Y.applyUpdate(docB, v1(docA));
      docB.getText("t").insert(3, "BBB");

      const docC = new Y.Doc();
      docC.clientID = 30;
      Y.applyUpdate(docC, v1(docA));
      Y.applyUpdate(docC, v1(docB));
      docC.getText("t").insert(6, "CCC");

      const merged = new Y.Doc();
      Y.applyUpdate(merged, v1(docA));
      Y.applyUpdate(merged, v1(docB));
      Y.applyUpdate(merged, v1(docC));

      const { sidecar: preSidecar } = stripContent(v1(merged), 1);

      // Delete client B's text only
      merged.getText("t").delete(3, 3);

      expectGcByteExact(merged, preSidecar, (d) => {
        expect(d.getText("t").toString()).toBe("AAACCC");
      });
    });

    // ── Multi-type document ──────────────────────────────────────────────

    it("byte-exact: complex document with mixed deletions across types", () => {
      const doc = new Y.Doc();
      doc.clientID = 1;

      // Text with formatting
      doc.getText("title").insert(0, "My Title");
      doc.getText("body").insert(0, "Body content here");
      doc.getText("body").format(0, 4, { bold: true });
      doc.getText("body").insertEmbed(18, { type: "hr" });

      // Map
      doc.getMap("meta").set("author", "Alice");
      doc.getMap("meta").set("version", 1);
      doc.getMap("meta").set("draft", true);

      // Array
      doc.getArray("tags").insert(0, ["alpha", "beta", "gamma"]);

      // Nested types
      const nested = new Y.Map();
      doc.getArray("sections").insert(0, [nested]);
      nested.set("title", "Section 1");

      const { sidecar: preSidecar } = stripContent(v1(doc), 1);

      // Selective deletions
      doc.getText("title").delete(0, 8); // Delete title text
      doc.getMap("meta").delete("draft"); // Delete draft flag
      doc.getMap("meta").set("version", 2); // Overwrite version
      doc.getArray("tags").delete(0, 2); // Delete "alpha", "beta"
      doc.getArray("sections").delete(0, 1); // Delete nested section

      expectGcByteExact(doc, preSidecar, (d) => {
        expect(d.getText("title").toString()).toBe("");
        expect(d.getText("body").toString()).toBe("Body content here");
        expect(d.getMap("meta").get("author")).toBe("Alice");
        expect(d.getMap("meta").get("version")).toBe(2);
        expect(d.getMap("meta").get("draft")).toBeUndefined();
        expect(d.getArray("tags").toArray()).toEqual(["gamma"]);
        expect(d.getArray("sections").length).toBe(0);
      });
    });

    // ── Unicode content ──────────────────────────────────────────────────

    it("byte-exact: unicode text partially deleted", () => {
      const doc = new Y.Doc();
      doc.clientID = 1;
      doc.getText("t").insert(0, "Hello 🌍🎉 World 日本語");
      const { sidecar: preSidecar } = stripContent(v1(doc), 1);

      doc.getText("t").delete(0, 11); // Delete "Hello 🌍🎉 " (emojis are 2 UTF-16 units)

      expectGcByteExact(doc, preSidecar, (d) => {
        expect(d.getText("t").toString()).toBe("World 日本語");
      });
    });

    // ── Multiple sequential deletions ────────────────────────────────────

    it("byte-exact: multiple delete waves with sidecar accumulation", () => {
      const doc = new Y.Doc();
      doc.clientID = 1;

      // Wave 1: initial content
      doc.getText("t").insert(0, "ABCDE");
      doc.getMap("m").set("x", 1);
      doc.getMap("m").set("y", 2);
      const { sidecar: s1 } = stripContent(v1(doc), 1);

      // Wave 2: delete some, add more
      doc.getText("t").delete(0, 2); // Delete "AB"
      doc.getText("t").insert(3, "FG");
      doc.getMap("m").delete("x");
      const { sidecar: s2 } = stripContent(v1(doc), 1);

      // Wave 3: more deletions
      doc.getText("t").delete(0, 1); // Delete "C"
      doc.getMap("m").set("y", 99);
      const { sidecar: s3 } = stripContent(v1(doc), 1);

      // Merge ALL accumulated sidecars
      const merged = mergeSidecars([s1, s2, s3]);

      // Current structure update
      const { update: currentStruct, sidecar: freshSidecar } = stripContent(v1(doc), 1);

      // GC the merged sidecar
      const gcedSidecar = gcSidecar(currentStruct, merged);

      // Restore from both and compare
      const restoredFresh = restoreContent(currentStruct, freshSidecar, 1);
      const restoredGced = restoreContent(currentStruct, gcedSidecar, 1);
      expect(Buffer.from(restoredGced).equals(Buffer.from(restoredFresh))).toBe(true);

      // Verify content
      const out = new Y.Doc();
      Y.applyUpdate(out, restoredGced);
      expect(out.getText("t").toString()).toBe("DEFG");
      expect(out.getMap("m").get("x")).toBeUndefined();
      expect(out.getMap("m").get("y")).toBe(99);
    });

    // ── V2 round-trip ────────────────────────────────────────────────────

    it("byte-exact: V2 input round-trip with GC", () => {
      const doc = new Y.Doc();
      doc.clientID = 1;
      doc.getText("t").insert(0, "Hello World");
      doc.getMap("m").set("key", "value");
      const { sidecar: preSidecar } = stripContent(v2(doc), 2);

      doc.getText("t").delete(0, 6);
      doc.getMap("m").delete("key");

      const originalV2 = v2(doc);
      const { update: structUpdate, sidecar: freshSidecar } = stripContent(originalV2, 2);

      const merged = mergeSidecars([preSidecar, freshSidecar]);
      const gcedSidecar = gcSidecar(structUpdate, merged);

      const restoredFresh = restoreContent(structUpdate, freshSidecar, 2);
      const restoredGced = restoreContent(structUpdate, gcedSidecar, 2);
      expect(Buffer.from(restoredGced).equals(Buffer.from(restoredFresh))).toBe(true);

      const out = new Y.Doc();
      Y.applyUpdateV2(out, restoredGced);
      expect(out.getText("t").toString()).toBe("World");
      expect(out.getMap("m").get("key")).toBeUndefined();
    });

    // ── Operations from Y.js test suite ──────────────────────────────────

    it("byte-exact: text applyDelta with delete + insert then GC", () => {
      const doc = new Y.Doc();
      doc.clientID = 1;
      doc.getText("t").insert(0, "Hello World");
      doc.getText("t").applyDelta([{ retain: 5 }, { delete: 1 }, { insert: ", " }]);
      const { sidecar: preSidecar } = stripContent(v1(doc), 1);

      doc.getText("t").delete(0, 7); // Delete "Hello, "

      expectGcByteExact(doc, preSidecar, (d) => {
        expect(d.getText("t").toString()).toBe("World");
      });
    });

    it("byte-exact: text insert with attributes then partial delete", () => {
      const doc = new Y.Doc();
      doc.clientID = 1;
      doc.getText("t").insert(0, "plain ");
      doc.getText("t").insert(6, "bold", { bold: true });
      doc.getText("t").insert(10, " italic", { italic: true });
      const { sidecar: preSidecar } = stripContent(v1(doc), 1);

      doc.getText("t").delete(0, 6); // Delete "plain "

      expectGcByteExact(doc, preSidecar, (d) => {
        const delta = d.getText("t").toDelta();
        expect(delta).toEqual([
          { insert: "bold", attributes: { bold: true } },
          { insert: " italic", attributes: { italic: true } },
        ]);
      });
    });

    it("byte-exact: nested YMap overwritten (old nested type GC'd)", () => {
      const doc = new Y.Doc();
      doc.clientID = 1;
      const outer = doc.getMap("m");
      const inner1 = new Y.Map();
      outer.set("nested", inner1);
      inner1.set("key", "first");
      const { sidecar: preSidecar } = stripContent(v1(doc), 1);

      // Overwrite with new nested type → old inner1 children become GC structs
      const inner2 = new Y.Map();
      outer.set("nested", inner2);
      inner2.set("key", "second");

      expectGcByteExact(doc, preSidecar, (d) => {
        const nested = d.getMap("m").get("nested") as Y.Map<string>;
        expect(nested.get("key")).toBe("second");
      });
    });

    it("byte-exact: array push/unshift then delete", () => {
      const doc = new Y.Doc();
      doc.clientID = 1;
      const arr = doc.getArray("a");
      arr.push([1, 2, 3]);
      arr.unshift([-1, 0]);
      const { sidecar: preSidecar } = stripContent(v1(doc), 1);

      arr.delete(0, 2); // Delete -1, 0

      expectGcByteExact(doc, preSidecar, (d) => {
        expect(d.getArray("a").toArray()).toEqual([1, 2, 3]);
      });
    });

    it("byte-exact: transaction grouping with partial GC", () => {
      const doc = new Y.Doc();
      doc.clientID = 1;
      doc.transact(() => {
        doc.getText("t").insert(0, "Hello World");
        doc.getText("t").format(0, 5, { bold: true });
        doc.getMap("m").set("a", 1);
        doc.getArray("a").push(["x", "y"]);
      });
      const { sidecar: preSidecar } = stripContent(v1(doc), 1);

      doc.transact(() => {
        doc.getText("t").delete(0, 6);
        doc.getMap("m").delete("a");
        doc.getArray("a").delete(0, 1);
      });

      expectGcByteExact(doc, preSidecar, (d) => {
        expect(d.getText("t").toString()).toBe("World");
        expect(d.getMap("m").get("a")).toBeUndefined();
        expect(d.getArray("a").toArray()).toEqual(["y"]);
      });
    });

    it("byte-exact: xml text with formatting deleted", () => {
      const doc = new Y.Doc();
      doc.clientID = 1;
      const frag = doc.getXmlFragment("xml");
      const el = new Y.XmlElement("p");
      frag.insert(0, [el]);
      const xt = new Y.XmlText("Hello World");
      el.insert(0, [xt]);
      xt.format(0, 5, { bold: true });
      const { sidecar: preSidecar } = stripContent(v1(doc), 1);

      frag.delete(0, 1); // Delete the <p> with formatted text

      expectGcByteExact(doc, preSidecar, (d) => {
        expect(d.getXmlFragment("xml").length).toBe(0);
      });
    });

    it("byte-exact: map with all primitive types, some deleted", () => {
      const doc = new Y.Doc();
      doc.clientID = 1;
      const map = doc.getMap("types");
      map.set("string", "hello");
      map.set("number", 42);
      map.set("float", 3.14159);
      map.set("bool", true);
      map.set("null", null);
      map.set("array", [1, 2, 3]);
      map.set("obj", { nested: true });
      const { sidecar: preSidecar } = stripContent(v1(doc), 1);

      map.delete("string");
      map.delete("float");
      map.delete("array");
      map.set("number", 99);

      expectGcByteExact(doc, preSidecar, (d) => {
        const m = d.getMap("types");
        expect(m.get("string")).toBeUndefined();
        expect(m.get("number")).toBe(99);
        expect(m.get("float")).toBeUndefined();
        expect(m.get("bool")).toBe(true);
        expect(m.get("null")).toBeNull();
        expect(m.get("array")).toBeUndefined();
        expect(m.get("obj")).toEqual({ nested: true });
      });
    });

    it("byte-exact: gc=false preserves all entries through GC pipeline", () => {
      const doc = new Y.Doc({ gc: false });
      doc.clientID = 1;
      doc.getText("t").insert(0, "Hello World");
      const { sidecar: preSidecar } = stripContent(v1(doc), 1);

      doc.getText("t").delete(0, 5);

      const originalUpdate = v1(doc);
      const { update: structUpdate, sidecar: freshSidecar } = stripContent(originalUpdate, 1);
      const merged = mergeSidecars([preSidecar, freshSidecar]);
      const gcedSidecar = gcSidecar(structUpdate, merged);

      // With gc=false, deleted items keep their content type, so all
      // sidecar entries are preserved and restore should be identical
      const restoredFresh = restoreContent(structUpdate, freshSidecar, 1);
      const restoredGced = restoreContent(structUpdate, gcedSidecar, 1);
      expect(Buffer.from(restoredGced).equals(Buffer.from(restoredFresh))).toBe(true);
      expect(Buffer.from(restoredGced).equals(Buffer.from(originalUpdate))).toBe(true);

      const out = new Y.Doc({ gc: false });
      Y.applyUpdate(out, restoredGced);
      expect(out.getText("t").toString()).toBe(" World");
    });
  });
});
