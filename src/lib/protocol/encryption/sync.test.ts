import { describe, expect, it } from "bun:test";
import { EncryptedBinary } from "../../../encryption-key";
import {
  decodeFromStateVector,
  decodeFromSyncStep2,
} from "./encoding";
import type { DecodedEncryptedUpdatePayload, EncryptedSnapshot } from "./encoding";
import {
  getDecodedStateVector,
  getDecodedSyncStep2,
  getEncryptedStateVector,
  getEncryptedSyncStep2,
} from "./sync";

describe("sync functions", () => {
  describe("getDecodedStateVector", () => {
    it("should return snapshot/version pair", () => {
      const decoded = getDecodedStateVector("snapshot-1", 7);
      expect(decoded.snapshotId).toBe("snapshot-1");
      expect(decoded.serverVersion).toBe(7);
    });
  });

  describe("getEncryptedStateVector", () => {
    it("should encode snapshot/version pair", () => {
      const encrypted = getEncryptedStateVector("snapshot-2", 11);
      const decoded = decodeFromStateVector(encrypted);

      expect(decoded.snapshotId).toBe("snapshot-2");
      expect(decoded.serverVersion).toBe(11);
    });
  });

  describe("getDecodedSyncStep2", () => {
    it("should return snapshot and updates", () => {
      const updates: DecodedEncryptedUpdatePayload[] = [
        {
          id: "msg1",
          snapshotId: "snapshot-1",
          timestamp: [1, 1],
          payload: new Uint8Array([1]) as EncryptedBinary,
          serverVersion: 1,
        },
      ];
      const snapshot: EncryptedSnapshot = {
        id: "snapshot-1",
        parentSnapshotId: null,
        payload: new Uint8Array([9]) as EncryptedBinary,
      };

      const decoded = getDecodedSyncStep2(updates, snapshot);
      expect(decoded.snapshot?.id).toBe("snapshot-1");
      expect(decoded.updates.length).toBe(1);
    });
  });

  describe("getEncryptedSyncStep2", () => {
    it("should encode and decode sync step 2", () => {
      const updates: DecodedEncryptedUpdatePayload[] = [
        {
          id: "msg1",
          snapshotId: "snapshot-1",
          timestamp: [1, 1],
          payload: new Uint8Array([1]) as EncryptedBinary,
          serverVersion: 1,
        },
      ];
      const snapshot: EncryptedSnapshot = {
        id: "snapshot-1",
        parentSnapshotId: null,
        payload: new Uint8Array([9]) as EncryptedBinary,
      };

      const encrypted = getEncryptedSyncStep2(updates, snapshot);
      const decoded = decodeFromSyncStep2(encrypted);
      expect(decoded.snapshot?.id).toBe("snapshot-1");
      expect(decoded.updates.length).toBe(1);
      expect(decoded.updates[0].serverVersion).toBe(1);
    });
  });
});
