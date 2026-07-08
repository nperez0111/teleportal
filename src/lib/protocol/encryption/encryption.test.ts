import { describe, expect, it } from "bun:test";
import { EncryptedBinary } from "../../../encryption-key";
import {
  encodeContentEncryptedPayload,
  decodeContentEncryptedPayload,
  getEmptyContentEncryptedPayload,
  isEmptyContentEncryptedPayload,
  mergeContentEncryptedPayloads,
  type ContentEncryptedPayload,
} from "./encoding";

describe("content-encrypted payload encoding", () => {
  it("round-trips a payload with one sidecar", () => {
    const payload: ContentEncryptedPayload = {
      structureUpdate: new Uint8Array([1, 2, 3, 4]),
      encryptedSidecars: [new Uint8Array([10, 20, 30]) as EncryptedBinary],
    };
    const encoded = encodeContentEncryptedPayload(payload);
    const decoded = decodeContentEncryptedPayload(encoded);

    expect(decoded.structureUpdate).toEqual(payload.structureUpdate);
    expect(decoded.encryptedSidecars.length).toBe(1);
    expect(decoded.encryptedSidecars[0]).toEqual(payload.encryptedSidecars[0]);
  });

  it("round-trips a payload with multiple sidecars", () => {
    const payload: ContentEncryptedPayload = {
      structureUpdate: new Uint8Array([5, 6, 7]),
      encryptedSidecars: [
        new Uint8Array([10, 20]) as EncryptedBinary,
        new Uint8Array([30, 40, 50]) as EncryptedBinary,
        new Uint8Array([60]) as EncryptedBinary,
      ],
    };
    const encoded = encodeContentEncryptedPayload(payload);
    const decoded = decodeContentEncryptedPayload(encoded);

    expect(decoded.structureUpdate).toEqual(payload.structureUpdate);
    expect(decoded.encryptedSidecars.length).toBe(3);
    for (let i = 0; i < 3; i++) {
      expect(decoded.encryptedSidecars[i]).toEqual(payload.encryptedSidecars[i]);
    }
  });

  it("round-trips a payload with no sidecars", () => {
    const payload: ContentEncryptedPayload = {
      structureUpdate: new Uint8Array([1]),
      encryptedSidecars: [],
    };
    const encoded = encodeContentEncryptedPayload(payload);
    const decoded = decodeContentEncryptedPayload(encoded);

    expect(decoded.structureUpdate).toEqual(new Uint8Array([1]));
    expect(decoded.encryptedSidecars.length).toBe(0);
  });

  it("round-trips an empty payload", () => {
    const payload: ContentEncryptedPayload = {
      structureUpdate: new Uint8Array(0),
      encryptedSidecars: [],
    };
    const encoded = encodeContentEncryptedPayload(payload);
    const decoded = decodeContentEncryptedPayload(encoded);

    expect(decoded.structureUpdate.length).toBe(0);
    expect(decoded.encryptedSidecars.length).toBe(0);
  });

  it("rejects invalid version", () => {
    const bad = new Uint8Array([99]) as any;
    expect(() => decodeContentEncryptedPayload(bad)).toThrow(
      "Failed to decode content-encrypted payload",
    );
  });

  it("getEmptyContentEncryptedPayload returns decodable empty payload", () => {
    const empty = getEmptyContentEncryptedPayload();
    const decoded = decodeContentEncryptedPayload(empty);
    expect(decoded.structureUpdate.length).toBe(0);
    expect(decoded.encryptedSidecars.length).toBe(0);
  });

  it("isEmptyContentEncryptedPayload detects empty payloads", () => {
    const empty = getEmptyContentEncryptedPayload();
    expect(isEmptyContentEncryptedPayload(empty)).toBe(true);

    const nonEmpty = encodeContentEncryptedPayload({
      structureUpdate: new Uint8Array([1]),
      encryptedSidecars: [new Uint8Array([2]) as EncryptedBinary],
    });
    expect(isEmptyContentEncryptedPayload(nonEmpty)).toBe(false);
  });
});

describe("compaction wire format", () => {
  it("round-trips a payload with compaction section", () => {
    const payload: ContentEncryptedPayload = {
      structureUpdate: new Uint8Array([1, 2, 3]),
      encryptedSidecars: [new Uint8Array([10, 20]) as EncryptedBinary],
      compaction: {
        sidecar: new Uint8Array([30, 40, 50]) as EncryptedBinary,
        index: [
          { clientId: 1, minClock: 0, maxClock: 5 },
          { clientId: 2, minClock: 0, maxClock: 3 },
        ],
        hash: new Uint8Array(32).fill(0xaa),
        sourceHashes: [new Uint8Array(32).fill(0xbb), new Uint8Array(32).fill(0xcc)],
      },
    };
    const encoded = encodeContentEncryptedPayload(payload);
    const decoded = decodeContentEncryptedPayload(encoded);

    expect(decoded.structureUpdate).toEqual(payload.structureUpdate);
    expect(decoded.encryptedSidecars.length).toBe(1);
    expect(decoded.compaction).toBeDefined();
    expect(decoded.compaction!.sidecar).toEqual(payload.compaction!.sidecar);
    expect(decoded.compaction!.index).toEqual(payload.compaction!.index);
    expect(decoded.compaction!.hash).toEqual(payload.compaction!.hash);
    expect(decoded.compaction!.sourceHashes.length).toBe(2);
    expect(decoded.compaction!.sourceHashes[0]).toEqual(payload.compaction!.sourceHashes[0]);
    expect(decoded.compaction!.sourceHashes[1]).toEqual(payload.compaction!.sourceHashes[1]);
  });

  it("round-trips a payload without compaction (explicit undefined)", () => {
    const payload: ContentEncryptedPayload = {
      structureUpdate: new Uint8Array([1]),
      encryptedSidecars: [],
      compaction: undefined,
    };
    const encoded = encodeContentEncryptedPayload(payload);
    const decoded = decodeContentEncryptedPayload(encoded);

    expect(decoded.compaction).toBeUndefined();
  });

  it("round-trips compaction with empty sourceHashes and index", () => {
    const payload: ContentEncryptedPayload = {
      structureUpdate: new Uint8Array([1]),
      encryptedSidecars: [],
      compaction: {
        sidecar: new Uint8Array([99]) as EncryptedBinary,
        index: [],
        hash: new Uint8Array(32).fill(0xff),
        sourceHashes: [],
      },
    };
    const encoded = encodeContentEncryptedPayload(payload);
    const decoded = decodeContentEncryptedPayload(encoded);

    expect(decoded.compaction).toBeDefined();
    expect(decoded.compaction!.sidecar).toEqual(payload.compaction!.sidecar);
    expect(decoded.compaction!.index).toEqual([]);
    expect(decoded.compaction!.sourceHashes).toEqual([]);
  });

  it("decodes payload from before compaction support (no trailing bytes)", () => {
    // Simulate an old-format payload by encoding without compaction and stripping the trailing 0 byte
    const payload: ContentEncryptedPayload = {
      structureUpdate: new Uint8Array([1, 2]),
      encryptedSidecars: [new Uint8Array([3]) as EncryptedBinary],
    };
    const encoded = encodeContentEncryptedPayload(payload);

    // The new encoder always writes hasCompaction byte, but old encoders wouldn't.
    // Test that a manually truncated payload (simulating old format) still decodes.
    // Find the position after sidecars and truncate there.
    // We know our encoder writes a trailing 0x00 for hasCompaction=false.
    // Remove it to simulate the old format.
    const truncated = encoded.slice(0, encoded.length - 1) as typeof encoded;
    const decoded = decodeContentEncryptedPayload(truncated);

    expect(decoded.structureUpdate).toEqual(new Uint8Array([1, 2]));
    expect(decoded.encryptedSidecars.length).toBe(1);
    expect(decoded.compaction).toBeUndefined();
  });
});

describe("mergeContentEncryptedPayloads", () => {
  it("returns empty payload for empty array", () => {
    const result = mergeContentEncryptedPayloads([]);
    const decoded = decodeContentEncryptedPayload(result);
    expect(decoded.structureUpdate.length).toBe(0);
    expect(decoded.encryptedSidecars.length).toBe(0);
  });

  it("returns the input for a single payload", () => {
    const payload = encodeContentEncryptedPayload({
      structureUpdate: new Uint8Array([1, 2, 3]),
      encryptedSidecars: [new Uint8Array([10, 20]) as EncryptedBinary],
    });
    const result = mergeContentEncryptedPayloads([payload]);
    expect(result).toBe(payload);
  });

  it("merges structure updates and concatenates sidecars", async () => {
    const Y = await import("yjs");
    const { encryptUpdateContent, decodeSidecar, restoreContent, mergeSidecars } =
      await import("./content-cipher");
    const { decryptUpdate, generateEncryptionKey } = await import("teleportal/encryption-key");

    const key = await generateEncryptionKey();

    const docA = new Y.Doc();
    docA.getText("t").insert(0, "hello");
    const updateA = Y.encodeStateAsUpdate(docA);

    const docB = new Y.Doc();
    docB.getText("t").insert(0, "world");
    const updateB = Y.encodeStateAsUpdate(docB);

    const encA = await encryptUpdateContent(key, updateA, 1);
    const encB = await encryptUpdateContent(key, updateB, 1);

    const payloadA = encodeContentEncryptedPayload({
      structureUpdate: encA.structureUpdate,
      encryptedSidecars: [encA.encryptedSidecar],
    });
    const payloadB = encodeContentEncryptedPayload({
      structureUpdate: encB.structureUpdate,
      encryptedSidecars: [encB.encryptedSidecar],
    });

    const merged = mergeContentEncryptedPayloads([payloadA, payloadB]);
    const decoded = decodeContentEncryptedPayload(merged);

    expect(decoded.encryptedSidecars.length).toBe(2);
    expect(decoded.structureUpdate.byteLength).toBeGreaterThan(0);

    const sidecars = [];
    for (const encrypted of decoded.encryptedSidecars) {
      const bytes = await decryptUpdate(key, encrypted);
      sidecars.push(decodeSidecar(bytes));
    }
    const fullUpdate = restoreContent(decoded.structureUpdate, mergeSidecars(sidecars));

    const verifyDoc = new Y.Doc();
    Y.applyUpdateV2(verifyDoc, fullUpdate);
    expect(verifyDoc.getText("t").toString()).toContain("hello");
    expect(verifyDoc.getText("t").toString()).toContain("world");
  });

  it("preserves a piggy-backed compaction through the merge", async () => {
    // A compaction attached to one payload must survive merging; dropping it
    // would leave the server's superseded sidecars uncollapsed since the
    // producer already cleared its pending compaction state.
    const Y = await import("yjs");
    const { encryptUpdateContent } = await import("./content-cipher");
    const { generateEncryptionKey } = await import("teleportal/encryption-key");
    const key = await generateEncryptionKey();

    const docA = new Y.Doc();
    docA.getText("t").insert(0, "hello");
    const encA = await encryptUpdateContent(key, Y.encodeStateAsUpdateV2(docA), 2);
    const docB = new Y.Doc();
    docB.getText("t").insert(0, "world");
    const encB = await encryptUpdateContent(key, Y.encodeStateAsUpdateV2(docB), 2);

    const compaction = {
      sidecar: new Uint8Array([99, 98, 97]) as EncryptedBinary,
      index: [{ clientId: 1, minClock: 0, maxClock: 5 }],
      hash: new Uint8Array([0xaa, 0xbb]),
      sourceHashes: [new Uint8Array([1, 1]), new Uint8Array([2, 2])],
    };
    const payloadA = encodeContentEncryptedPayload({
      structureUpdate: encA.structureUpdate,
      encryptedSidecars: [encA.encryptedSidecar],
      compaction,
    });
    const payloadB = encodeContentEncryptedPayload({
      structureUpdate: encB.structureUpdate,
      encryptedSidecars: [encB.encryptedSidecar],
    });

    const decoded = decodeContentEncryptedPayload(
      mergeContentEncryptedPayloads([payloadA, payloadB]),
    );

    expect(decoded.compaction).toBeDefined();
    expect(decoded.compaction!.index).toEqual(compaction.index);
    expect(decoded.compaction!.sourceHashes.length).toBe(2);
    expect(Buffer.from(decoded.compaction!.sidecar)).toEqual(Buffer.from(compaction.sidecar));
  });
});
