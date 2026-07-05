import { describe, expect, it } from "bun:test";
import * as Y from "yjs";
import { createEncryptionKey, encryptUpdate, decryptUpdate } from "teleportal/encryption-key";
import {
  encryptUpdateContent,
  decryptUpdateContent,
  encryptToContentPayload,
  decryptContentPayload,
  mergeSidecars,
  compactSidecars,
  encodeSidecar,
  decodeSidecar,
  restoreContent,
  hashSidecar,
  type ContentEntry,
  type Sidecar,
} from "./content-cipher";
import {
  encodeContentEncryptedPayload,
  decodeContentEncryptedPayload,
  getEmptyContentEncryptedPayload,
  type ContentEncryptedPayload,
  type EncryptedUpdatePayload,
} from "./encoding";

// ── Helpers ───────────────────────────────────────────────────────────────

function makeDoc(fn: (doc: Y.Doc) => void, clientId?: number): Y.Doc {
  const doc = new Y.Doc();
  if (clientId !== undefined) doc.clientID = clientId;
  fn(doc);
  return doc;
}

function v1(doc: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(doc);
}

function v2(doc: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdateV2(doc);
}

describe("content-cipher: high-level encryption + sidecar compaction", () => {
  // ── Scenario 1: round-trip with a real CryptoKey, V1 & V2 ────────────────

  describe("encryptUpdateContent / decryptUpdateContent round trip", () => {
    it("round-trips a V1 update back to the identical doc state (V1 output)", async () => {
      const key = await createEncryptionKey();
      const src = makeDoc((d) => {
        d.getText("t").insert(0, "Hello secret World");
        d.getMap("m").set("password", "hunter2");
        d.getArray("a").insert(0, [1, "two", true, null]);
      });
      const original = v1(src);

      const encrypted = await encryptUpdateContent(key, original, 1);
      const decrypted = await decryptUpdateContent(key, encrypted, 1);

      const out = new Y.Doc();
      Y.applyUpdate(out, decrypted);
      expect(out.getText("t").toString()).toBe("Hello secret World");
      expect(out.getMap("m").get("password")).toBe("hunter2");
      expect(out.getArray("a").toArray()).toEqual([1, "two", true, null]);
      // State vector is preserved
      expect(Y.encodeStateVector(out)).toEqual(Y.encodeStateVector(src));
    });

    it("round-trips a V2 update back to the identical doc state (V2 output)", async () => {
      const key = await createEncryptionKey();
      const src = makeDoc((d) => {
        d.getText("t").insert(0, "V2 secret");
        d.getText("t").format(0, 2, { bold: true });
      });
      const original = v2(src);

      const encrypted = await encryptUpdateContent(key, original, 2);
      const decrypted = await decryptUpdateContent(key, encrypted, 2);

      const out = new Y.Doc();
      Y.applyUpdateV2(out, decrypted);
      expect(out.getText("t").toDelta()).toEqual([
        { insert: "V2", attributes: { bold: true } },
        { insert: " secret" },
      ]);
      expect(Y.encodeStateVector(out)).toEqual(Y.encodeStateVector(src));
    });

    it("can cross versions: V1 input -> V1 output is byte-exact with original", async () => {
      const key = await createEncryptionKey();
      const src = makeDoc((d) => d.getText("t").insert(0, "cross-version"));
      const original = v1(src);

      const encrypted = await encryptUpdateContent(key, original, 1);
      const decrypted = await decryptUpdateContent(key, encrypted, 1);

      // V1 -> structure is V2 -> restore to V1 should reproduce original bytes
      expect(Buffer.from(decrypted).equals(Buffer.from(original))).toBe(true);
    });

    it("structure update never contains the plaintext content", async () => {
      const key = await createEncryptionKey();
      const src = makeDoc((d) => d.getText("t").insert(0, "TOP-SECRET-VALUE"));
      const encrypted = await encryptUpdateContent(key, v1(src), 1);
      const asStr = Buffer.from(encrypted.structureUpdate).toString("utf-8");
      expect(asStr).not.toContain("TOP-SECRET-VALUE");
    });
  });

  // ── Scenario 2: wrong key fails ──────────────────────────────────────────

  describe("wrong-key decryption", () => {
    it("decryptUpdateContent throws (AES-GCM auth failure) with the wrong key", async () => {
      const key1 = await createEncryptionKey();
      const key2 = await createEncryptionKey();
      const src = makeDoc((d) => d.getText("t").insert(0, "Secret"));
      const encrypted = await encryptUpdateContent(key1, v1(src), 1);
      await expect(decryptUpdateContent(key2, encrypted, 1)).rejects.toThrow(/Decryption failed/);
    });

    it("decryptContentPayload throws with the wrong key", async () => {
      const key1 = await createEncryptionKey();
      const key2 = await createEncryptionKey();
      const src = makeDoc((d) => d.getText("t").insert(0, "Secret"));
      const enc = await encryptUpdateContent(key1, v1(src), 1);
      await expect(
        decryptContentPayload(key2, enc.structureUpdate, [enc.encryptedSidecar], 1),
      ).rejects.toThrow(/Decryption failed/);
    });
  });

  // ── encryptToContentPayload + decryptContentPayload (multi-sidecar) ───────

  describe("encryptToContentPayload + decryptContentPayload", () => {
    it("encrypts a V2 update to a payload and round-trips via decode + decrypt", async () => {
      const key = await createEncryptionKey();
      const src = makeDoc((d) => {
        d.getText("t").insert(0, "payload content");
        d.getMap("m").set("k", "v");
      });
      const payloadBytes = await encryptToContentPayload(key, v2(src));

      const payload = decodeContentEncryptedPayload(payloadBytes as EncryptedUpdatePayload);
      expect(payload.encryptedSidecars.length).toBe(1);
      expect(payload.compaction).toBeUndefined();

      const decrypted = await decryptContentPayload(
        key,
        payload.structureUpdate,
        payload.encryptedSidecars,
        2,
      );
      const out = new Y.Doc();
      Y.applyUpdateV2(out, decrypted);
      expect(out.getText("t").toString()).toBe("payload content");
      expect(out.getMap("m").get("k")).toBe("v");
    });

    // ── Scenario 3: multiple independent updates -> merged structure + sidecars

    it("merges multiple structure updates + all sidecars to reconstruct the full doc", async () => {
      const key = await createEncryptionKey();

      // Three independent docs (distinct client IDs) each contributing a root type.
      const docA = makeDoc((d) => d.getText("ta").insert(0, "alpha text"), 11);
      const docB = makeDoc((d) => d.getMap("mb").set("beta", "beta-value"), 22);
      const docC = makeDoc((d) => d.getArray("ac").insert(0, ["gamma", 99]), 33);

      const encA = await encryptUpdateContent(key, v2(docA), 2);
      const encB = await encryptUpdateContent(key, v2(docB), 2);
      const encC = await encryptUpdateContent(key, v2(docC), 2);

      // Server merges the structure updates with Y.js.
      const mergedStructure = Y.mergeUpdatesV2([
        encA.structureUpdate,
        encB.structureUpdate,
        encC.structureUpdate,
      ]);

      const decrypted = await decryptContentPayload(
        key,
        mergedStructure,
        [encA.encryptedSidecar, encB.encryptedSidecar, encC.encryptedSidecar],
        2,
      );

      const out = new Y.Doc();
      Y.applyUpdateV2(out, decrypted);
      expect(out.getText("ta").toString()).toBe("alpha text");
      expect(out.getMap("mb").get("beta")).toBe("beta-value");
      expect(out.getArray("ac").toArray()).toEqual(["gamma", 99]);
    });

    it("merged sidecar order does not matter for reconstruction", async () => {
      const key = await createEncryptionKey();
      const docA = makeDoc((d) => d.getText("ta").insert(0, "alpha"), 11);
      const docB = makeDoc((d) => d.getText("tb").insert(0, "beta"), 22);
      const encA = await encryptUpdateContent(key, v2(docA), 2);
      const encB = await encryptUpdateContent(key, v2(docB), 2);
      const merged = Y.mergeUpdatesV2([encA.structureUpdate, encB.structureUpdate]);

      // Reversed sidecar order
      const decrypted = await decryptContentPayload(
        key,
        merged,
        [encB.encryptedSidecar, encA.encryptedSidecar],
        2,
      );
      const out = new Y.Doc();
      Y.applyUpdateV2(out, decrypted);
      expect(out.getText("ta").toString()).toBe("alpha");
      expect(out.getText("tb").toString()).toBe("beta");
    });
  });

  // ── mergeSidecars ────────────────────────────────────────────────────────

  describe("mergeSidecars", () => {
    it("concatenates entries and unions dictionaries across sidecars", () => {
      const s1: Sidecar = {
        entries: [
          { clientId: 1, clock: 0, contentRef: 4, data: new Uint8Array([1]), itemLength: 1 },
        ],
        dictionary: new Map([["tokA", "alpha"]]),
      };
      const s2: Sidecar = {
        entries: [
          { clientId: 2, clock: 0, contentRef: 4, data: new Uint8Array([2]), itemLength: 1 },
          { clientId: 2, clock: 1, contentRef: 8, data: new Uint8Array([3]), itemLength: 1 },
        ],
        dictionary: new Map([["tokB", "beta"]]),
      };
      const merged = mergeSidecars([s1, s2]);
      expect(merged.entries.length).toBe(3);
      expect(merged.entries).toEqual([...s1.entries, ...s2.entries]);
      expect(merged.dictionary).toEqual(
        new Map([
          ["tokA", "alpha"],
          ["tokB", "beta"],
        ]),
      );
    });

    it("returns an empty sidecar for an empty input list", () => {
      const merged = mergeSidecars([]);
      expect(merged.entries).toEqual([]);
      expect(merged.dictionary.size).toBe(0);
    });

    it("resolves conflicting dictionary tokens with last-writer-wins", () => {
      // Same token key mapping to different originals across sidecars.
      const s1: Sidecar = {
        entries: [],
        dictionary: new Map([["dup", "first"]]),
      };
      const s2: Sidecar = {
        entries: [],
        dictionary: new Map([["dup", "second"]]),
      };
      const s3: Sidecar = {
        entries: [],
        dictionary: new Map([["dup", "third"]]),
      };
      // Map.set in iteration order means the last sidecar wins.
      expect(mergeSidecars([s1, s2, s3]).dictionary.get("dup")).toBe("third");
      // Order is what determines the winner.
      expect(mergeSidecars([s3, s2, s1]).dictionary.get("dup")).toBe("first");
    });

    it("preserves duplicate entries (merge does NOT dedup)", () => {
      const dup: ContentEntry = {
        clientId: 7,
        clock: 3,
        contentRef: 4,
        data: new Uint8Array([9]),
        itemLength: 1,
      };
      const merged = mergeSidecars([
        { entries: [dup], dictionary: new Map() },
        { entries: [dup], dictionary: new Map() },
      ]);
      expect(merged.entries.length).toBe(2);
    });
  });

  // ── Scenario 4: compactSidecars ──────────────────────────────────────────

  describe("compactSidecars", () => {
    it("returns null for 0 sidecars", async () => {
      const key = await createEncryptionKey();
      expect(await compactSidecars(key, [])).toBeNull();
    });

    it("returns null for 1 sidecar", async () => {
      const key = await createEncryptionKey();
      const src = makeDoc((d) => d.getText("t").insert(0, "x"));
      const enc = await encryptUpdateContent(key, v2(src), 2);
      expect(await compactSidecars(key, [enc.encryptedSidecar])).toBeNull();
    });

    it("compacts overlapping sidecars; compacted sidecar restores the full doc", async () => {
      const key = await createEncryptionKey();

      // A single doc edited in three growing snapshots from the SAME client.
      // Each full-state snapshot re-encodes the (contiguous) text run as a
      // single ContentString item at clock 0, so all three sidecars carry an
      // overlapping entry keyed `1:0` whose data grows. Compaction must
      // collapse them to one entry holding the latest (full) content.
      const doc = makeDoc((d) => d.getText("t").insert(0, "Hello"), 1);
      const snap1 = await encryptUpdateContent(key, v2(doc), 2);

      doc.getText("t").insert(5, " World");
      const snapFull2 = await encryptUpdateContent(key, v2(doc), 2);

      doc.getText("t").insert(11, "!!!");
      const snapFull3 = await encryptUpdateContent(key, v2(doc), 2);

      // The latest full-state structure update covers the final document.
      const finalStructure = snapFull3.structureUpdate;

      const sidecars = [
        snap1.encryptedSidecar,
        snapFull2.encryptedSidecar,
        snapFull3.encryptedSidecar,
      ];

      const compacted = await compactSidecars(key, sidecars);
      expect(compacted).not.toBeNull();
      const c = compacted!;

      // hash matches the encrypted bytes
      expect(Buffer.from(c.hash).equals(Buffer.from(await hashSidecar(c.encrypted)))).toBe(true);

      // Decrypt the compacted sidecar and verify dedup: no duplicate clientId:clock.
      const decoded = decodeSidecar(await decryptUpdate(key, c.encrypted));
      const keys = decoded.entries.map((e) => `${e.clientId}:${e.clock}`);
      expect(new Set(keys).size).toBe(keys.length);
      // The three overlapping `1:0` entries collapse to exactly one.
      expect(keys).toEqual(["1:0"]);

      // The compacted (deduped) sidecar, used against the final full structure
      // update, reconstructs the full document — i.e. dedup kept the LATEST
      // (full) content, not a stale earlier snapshot.
      const restored = restoreContent(finalStructure, decoded, 2);
      const out = new Y.Doc();
      Y.applyUpdateV2(out, restored);
      expect(out.getText("t").toString()).toBe("Hello World!!!");

      // Index reflects the single deduped entry for client 1, covering the
      // full 14-char "Hello World!!!" run (clocks 0-13).
      expect(c.index).toEqual([{ clientId: 1, minClock: 0, maxClock: 13 }]);
    });

    it("dedups multiple clients' overlapping entries into one each", async () => {
      const key = await createEncryptionKey();

      // Two clients, each contributing a contiguous run (one item at clock 0).
      const docA = makeDoc((d) => d.getText("ta").insert(0, "alpha"), 1);
      const docB = makeDoc((d) => d.getText("tb").insert(0, "beta"), 2);
      const a = await encryptUpdateContent(key, v2(docA), 2);
      const b = await encryptUpdateContent(key, v2(docB), 2);

      // Sidecars repeated to force duplicate keys across the input set.
      const compacted = await compactSidecars(key, [
        a.encryptedSidecar,
        b.encryptedSidecar,
        a.encryptedSidecar,
        b.encryptedSidecar,
      ]);
      const c = compacted!;
      const decoded = decodeSidecar(await decryptUpdate(key, c.encrypted));

      const keys = decoded.entries.map((e) => `${e.clientId}:${e.clock}`).sort();
      // 4 input sidecars (2 distinct) collapse to exactly 2 unique entries.
      expect(keys).toEqual(["1:0", "2:0"]);
      expect(c.index.map((r) => r.clientId).sort()).toEqual([1, 2]);
    });
  });

  // ── decode/encode ContentEncryptedPayload round trip ─────────────────────

  describe("encodeContentEncryptedPayload / decodeContentEncryptedPayload", () => {
    it("round-trips a payload without compaction", () => {
      const payload: ContentEncryptedPayload = {
        structureUpdate: new Uint8Array([1, 2, 3, 4]),
        encryptedSidecars: [new Uint8Array([5, 6]), new Uint8Array([7, 8, 9])],
      };
      const decoded = decodeContentEncryptedPayload(encodeContentEncryptedPayload(payload));
      expect(decoded.wireVersion).toBe(1);
      expect(Buffer.from(decoded.structureUpdate)).toEqual(Buffer.from(payload.structureUpdate));
      expect(decoded.encryptedSidecars.length).toBe(2);
      expect(Buffer.from(decoded.encryptedSidecars[0])).toEqual(Buffer.from([5, 6]));
      expect(Buffer.from(decoded.encryptedSidecars[1])).toEqual(Buffer.from([7, 8, 9]));
      expect(decoded.compaction).toBeUndefined();
    });

    it("round-trips a payload WITH compaction (index, hash, sourceHashes)", () => {
      const payload: ContentEncryptedPayload = {
        structureUpdate: new Uint8Array([10, 20]),
        encryptedSidecars: [new Uint8Array([1])],
        compaction: {
          sidecar: new Uint8Array([99, 98, 97]),
          index: [
            { clientId: 1, minClock: 0, maxClock: 10 },
            { clientId: 2, minClock: 5, maxClock: 5 },
          ],
          hash: new Uint8Array([0xaa, 0xbb, 0xcc]),
          sourceHashes: [new Uint8Array([1, 1, 1]), new Uint8Array([2, 2, 2])],
        },
      };
      const decoded = decodeContentEncryptedPayload(encodeContentEncryptedPayload(payload));
      expect(decoded.compaction).toBeDefined();
      const comp = decoded.compaction!;
      expect(Buffer.from(comp.sidecar)).toEqual(Buffer.from([99, 98, 97]));
      expect(comp.index).toEqual(payload.compaction!.index);
      expect(Buffer.from(comp.hash)).toEqual(Buffer.from([0xaa, 0xbb, 0xcc]));
      expect(comp.sourceHashes.length).toBe(2);
      expect(Buffer.from(comp.sourceHashes[0])).toEqual(Buffer.from([1, 1, 1]));
      expect(Buffer.from(comp.sourceHashes[1])).toEqual(Buffer.from([2, 2, 2]));
    });

    it("end-to-end: real compaction output survives the payload round trip", async () => {
      const key = await createEncryptionKey();
      const doc = makeDoc((d) => d.getText("t").insert(0, "abc"), 5);
      const s1 = await encryptUpdateContent(key, v2(doc), 2);
      doc.getText("t").insert(3, "def");
      const s2 = await encryptUpdateContent(key, v2(doc), 2);
      const compacted = (await compactSidecars(key, [s1.encryptedSidecar, s2.encryptedSidecar]))!;

      const payload: ContentEncryptedPayload = {
        structureUpdate: s2.structureUpdate,
        encryptedSidecars: [s2.encryptedSidecar],
        compaction: {
          sidecar: compacted.encrypted,
          index: compacted.index,
          hash: compacted.hash,
          sourceHashes: [await hashSidecar(s1.encryptedSidecar), await hashSidecar(s2.encryptedSidecar)],
        },
      };
      const decoded = decodeContentEncryptedPayload(encodeContentEncryptedPayload(payload));
      const comp = decoded.compaction!;

      // The decoded compacted sidecar is still decryptable + restores the doc.
      const restored = await decryptContentPayload(key, decoded.structureUpdate, [comp.sidecar], 2);
      const out = new Y.Doc();
      Y.applyUpdateV2(out, restored);
      expect(out.getText("t").toString()).toBe("abcdef");
      expect(comp.index).toEqual(compacted.index);
      expect(Buffer.from(comp.hash)).toEqual(Buffer.from(compacted.hash));
    });

    it("getEmptyContentEncryptedPayload decodes to an empty payload", () => {
      const decoded = decodeContentEncryptedPayload(getEmptyContentEncryptedPayload());
      expect(decoded.structureUpdate.length).toBe(0);
      expect(decoded.encryptedSidecars.length).toBe(0);
      expect(decoded.compaction).toBeUndefined();
    });

    it("rejects an unsupported wire version", () => {
      // version byte = 2 (unsupported); decode wraps the error.
      const bad = new Uint8Array([2, 0]) as EncryptedUpdatePayload;
      expect(() => decodeContentEncryptedPayload(bad)).toThrow(
        /Failed to decode content-encrypted payload/,
      );
    });
  });

  // ── encodeSidecar interplay with encrypt for compaction inputs ───────────

  describe("hashSidecar", () => {
    it("is deterministic and 32 bytes (sha256)", async () => {
      const key = await createEncryptionKey();
      const enc = await encryptUpdate(key, encodeSidecar({ entries: [], dictionary: new Map() }));
      const h1 = await hashSidecar(enc);
      const h2 = await hashSidecar(enc);
      expect(h1.length).toBe(32);
      expect(Buffer.from(h1)).toEqual(Buffer.from(h2));
    });
  });
});
