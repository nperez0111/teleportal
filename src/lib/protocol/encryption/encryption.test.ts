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
    const { createEncryptionKey, decryptUpdate } = await import("teleportal/encryption-key");

    const key = await createEncryptionKey();

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
    Y.applyUpdate(verifyDoc, fullUpdate);
    expect(verifyDoc.getText("t").toString()).toContain("hello");
    expect(verifyDoc.getText("t").toString()).toContain("world");
  });
});
