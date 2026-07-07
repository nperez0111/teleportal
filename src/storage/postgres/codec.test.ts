import { describe, expect, it } from "bun:test";

import type { IndexedSidecar } from "../../lib/protocol/encryption/content-cipher";
import type { EncryptedBinary } from "teleportal/encryption-key";
import type { PendingUpdate } from "../document-storage";
import {
  decodeIndexedSidecars,
  decodePendingUpdate,
  encodeIndexedSidecars,
  encodePendingUpdate,
} from "./codec";

function makeSidecar(seed: number): IndexedSidecar {
  const encrypted = new Uint8Array([seed, seed + 1, seed + 2, seed + 3]) as EncryptedBinary;
  const hash = new Uint8Array(32).fill(seed);
  return {
    encrypted,
    index: [
      { clientId: 1000 + seed, minClock: 0, maxClock: seed * 10 },
      { clientId: 2 ** 31 + seed, minClock: 5, maxClock: 6 },
    ],
    hash,
  };
}

describe("postgres codec", () => {
  describe("encodeIndexedSidecars / decodeIndexedSidecars", () => {
    it("round-trips an empty sidecar list", () => {
      const encoded = encodeIndexedSidecars([]);
      expect(decodeIndexedSidecars(encoded)).toEqual([]);
    });

    it("round-trips multiple sidecars with indexes and hashes", () => {
      const sidecars = [makeSidecar(1), makeSidecar(7), makeSidecar(42)];
      const decoded = decodeIndexedSidecars(encodeIndexedSidecars(sidecars));
      expect(decoded).toEqual(sidecars);
    });

    it("round-trips a sidecar with an empty index", () => {
      const sidecar: IndexedSidecar = {
        encrypted: new Uint8Array([9]) as EncryptedBinary,
        index: [],
        hash: new Uint8Array(32),
      };
      expect(decodeIndexedSidecars(encodeIndexedSidecars([sidecar]))).toEqual([sidecar]);
    });
  });

  describe("encodePendingUpdate / decodePendingUpdate", () => {
    it("round-trips an entry without compaction", () => {
      const entry: PendingUpdate = {
        structureUpdate: new Uint8Array([1, 2, 3, 4, 5]),
        sidecars: [makeSidecar(3)],
      };
      const decoded = decodePendingUpdate(encodePendingUpdate(entry));
      expect(decoded.structureUpdate).toEqual(entry.structureUpdate);
      expect(decoded.sidecars).toEqual(entry.sidecars);
      expect(decoded.compaction).toBeUndefined();
    });

    it("round-trips an entry with empty sidecars (unencrypted path)", () => {
      const entry: PendingUpdate = {
        structureUpdate: new Uint8Array([255, 0, 128]),
        sidecars: [],
      };
      const decoded = decodePendingUpdate(encodePendingUpdate(entry));
      expect(decoded.structureUpdate).toEqual(entry.structureUpdate);
      expect(decoded.sidecars).toEqual([]);
      expect(decoded.compaction).toBeUndefined();
    });

    it("round-trips an entry with compaction", () => {
      const entry: PendingUpdate = {
        structureUpdate: new Uint8Array([1, 2, 3]),
        sidecars: [makeSidecar(5)],
        compaction: {
          sidecar: new Uint8Array([10, 11, 12]) as EncryptedBinary,
          index: [{ clientId: 77, minClock: 1, maxClock: 9 }],
          hash: new Uint8Array(32).fill(0xab),
          sourceHashes: [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)],
        },
      };
      const decoded = decodePendingUpdate(encodePendingUpdate(entry));
      expect(decoded.structureUpdate).toEqual(entry.structureUpdate);
      expect(decoded.sidecars).toEqual(entry.sidecars);
      expect(decoded.compaction).toEqual(entry.compaction!);
    });

    it("rejects payloads with an unknown version", () => {
      const encoded = encodePendingUpdate({
        structureUpdate: new Uint8Array([1]),
        sidecars: [],
      });
      const corrupted = new Uint8Array(encoded);
      corrupted[0] = 250;
      expect(() => decodePendingUpdate(corrupted)).toThrow();
    });
  });
});
