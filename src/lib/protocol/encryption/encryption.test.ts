import { describe, expect, it } from "bun:test";
import { digest } from "lib0/hash/sha256";
import { toBase64 } from "lib0/buffer";
import { EncryptedBinary } from "../../../encryption-key";
import type {
  DecodedEncryptedStateVector,
  DecodedEncryptedSyncStep2,
  DecodedEncryptedUpdatePayload,
  EncryptedSnapshot,
  EncryptedStateVector,
  EncryptedSyncStep2,
  EncryptedUpdatePayload,
} from "./encoding";
import {
  decodeEncryptedUpdate,
  decodeFromStateVector,
  decodeFromSyncStep2,
  encodeEncryptedSnapshot,
  encodeEncryptedUpdate,
  encodeEncryptedUpdateMessages,
  encodeToStateVector,
  encodeToSyncStep2,
  getEmptyEncryptedUpdate,
  getEmptyEncryptedStateVector,
  getEmptyEncryptedSyncStep2,
} from "./encoding";
import type { LamportClockValue } from "./lamport-clock";

describe("protocol encryption encoding", () => {
  describe("state vector encoding/decoding", () => {
    it("should encode and decode empty state vector", () => {
      const emptyState: DecodedEncryptedStateVector = {
        snapshotId: "",
        serverVersion: 0,
      };
      const encoded = encodeToStateVector(emptyState);
      const decoded = decodeFromStateVector(encoded);

      expect(decoded.snapshotId).toBe("");
      expect(decoded.serverVersion).toBe(0);
    });

    it("should encode and decode state vector with snapshot info", () => {
      const state: DecodedEncryptedStateVector = {
        snapshotId: "snapshot-1",
        serverVersion: 42,
      };
      const encoded = encodeToStateVector(state);
      const decoded = decodeFromStateVector(encoded);

      expect(decoded.snapshotId).toBe("snapshot-1");
      expect(decoded.serverVersion).toBe(42);
    });

    it("should throw error for invalid version", () => {
      const invalidData = new Uint8Array([1, 0, 0]); // version 1 instead of 0
      expect(() =>
        decodeFromStateVector(invalidData as EncryptedStateVector),
      ).toThrow("Failed to decode encrypted state vector");
    });

    it("should return empty state vector", () => {
      const empty = getEmptyEncryptedStateVector();
      const decoded = decodeFromStateVector(empty);
      expect(decoded.snapshotId).toBe("");
      expect(decoded.serverVersion).toBe(0);
    });
  });

  describe("encrypted update encoding/decoding", () => {
    it("should encode and decode empty update messages", () => {
      const emptyMessages: DecodedEncryptedUpdatePayload[] = [];
      const encoded = encodeEncryptedUpdateMessages(emptyMessages);
      const decoded = decodeEncryptedUpdate(encoded);

      expect(decoded.type).toBe("update");
      expect(decoded.updates.length).toBe(0);
    });

    it("should encode and decode single update message", () => {
      const testUpdate = new Uint8Array([1, 2, 3, 4, 5]) as EncryptedBinary;
      const timestamp: LamportClockValue = [1, 5];
      const message: DecodedEncryptedUpdatePayload = {
        id: toBase64(digest(testUpdate)),
        snapshotId: "snapshot-1",
        timestamp,
        payload: testUpdate,
      };

      const encoded = encodeEncryptedUpdateMessages([message]);
      const decoded = decodeEncryptedUpdate(encoded);

      expect(decoded.type).toBe("update");
      expect(decoded.updates.length).toBe(1);
      expect(decoded.updates[0].snapshotId).toBe("snapshot-1");
      expect(decoded.updates[0].timestamp).toEqual(timestamp);
      expect(decoded.updates[0].payload).toEqual(testUpdate);
    });

    it("should encode and decode multiple update messages", () => {
      const messages: DecodedEncryptedUpdatePayload[] = [
        {
          id: "msg1",
          snapshotId: "snapshot-1",
          timestamp: [1, 5],
          payload: new Uint8Array([1, 2, 3]) as EncryptedBinary,
          serverVersion: 1,
        },
        {
          id: "msg2",
          snapshotId: "snapshot-1",
          timestamp: [2, 10],
          payload: new Uint8Array([4, 5, 6]) as EncryptedBinary,
          serverVersion: 2,
        },
      ];

      const encoded = encodeEncryptedUpdateMessages(messages);
      const decoded = decodeEncryptedUpdate(encoded);

      expect(decoded.type).toBe("update");
      expect(decoded.updates.length).toBe(2);
      expect(decoded.updates[0].serverVersion).toBe(1);
      expect(decoded.updates[1].serverVersion).toBe(2);
    });

    it("should encode single encrypted update", () => {
      const testUpdate = new Uint8Array([1, 2, 3, 4, 5]) as EncryptedBinary;
      const timestamp: LamportClockValue = [1, 5];

      const encoded = encodeEncryptedUpdate(
        testUpdate,
        "snapshot-1",
        timestamp,
      );
      const decoded = decodeEncryptedUpdate(encoded);

      expect(decoded.type).toBe("update");
      expect(decoded.updates.length).toBe(1);
      expect(decoded.updates[0].timestamp).toEqual(timestamp);
      expect(decoded.updates[0].payload).toEqual(testUpdate);
    });

    it("should encode and decode snapshot messages", () => {
      const snapshot: EncryptedSnapshot = {
        id: "snapshot-1",
        parentSnapshotId: null,
        payload: new Uint8Array([9, 9, 9]) as EncryptedBinary,
      };
      const encoded = encodeEncryptedSnapshot(snapshot);
      const decoded = decodeEncryptedUpdate(encoded);

      expect(decoded.type).toBe("snapshot");
      expect(decoded.snapshot.id).toBe("snapshot-1");
      expect(decoded.snapshot.payload).toEqual(snapshot.payload);
    });

    it("should throw error for invalid update version", () => {
      const invalidData = new Uint8Array([1, 0, 0]); // version 1 instead of 0
      expect(() =>
        decodeEncryptedUpdate(invalidData as EncryptedUpdatePayload),
      ).toThrow("Failed to decode encrypted update");
    });

    it("should return empty encrypted update", () => {
      const empty = getEmptyEncryptedUpdate();
      const decoded = decodeEncryptedUpdate(empty);
      expect(decoded.type).toBe("update");
      expect(decoded.updates.length).toBe(0);
    });
  });

  describe("sync step 2 encoding/decoding", () => {
    it("should encode and decode empty sync step 2", () => {
      const emptySync: DecodedEncryptedSyncStep2 = { updates: [] };
      const encoded = encodeToSyncStep2(emptySync);
      const decoded = decodeFromSyncStep2(encoded);

      expect(decoded.updates.length).toBe(0);
      expect(decoded.snapshot).toBeNull();
    });

    it("should encode and decode sync step 2 with snapshot and updates", () => {
      const snapshot: EncryptedSnapshot = {
        id: "snapshot-1",
        parentSnapshotId: null,
        payload: new Uint8Array([1, 1, 1]) as EncryptedBinary,
      };
      const updates: DecodedEncryptedUpdatePayload[] = [
        {
          id: "msg1",
          snapshotId: "snapshot-1",
          timestamp: [1, 5],
          payload: new Uint8Array([1, 2, 3]) as EncryptedBinary,
          serverVersion: 1,
        },
      ];
      const sync: DecodedEncryptedSyncStep2 = { snapshot, updates };

      const encoded = encodeToSyncStep2(sync);
      const decoded = decodeFromSyncStep2(encoded);

      expect(decoded.snapshot?.id).toBe("snapshot-1");
      expect(decoded.updates.length).toBe(1);
      expect(decoded.updates[0].serverVersion).toBe(1);
    });

    it("should throw error for invalid sync step 2 version", () => {
      const invalidData = new Uint8Array([1, 0, 0]); // version 1 instead of 0
      expect(() =>
        decodeFromSyncStep2(invalidData as EncryptedSyncStep2),
      ).toThrow("Failed to decode encrypted sync step 2 message");
    });
  });
});
