import { describe, expect, it } from "bun:test";
import { EncryptedUpdate } from "../../../encryption-key";
import type {
  DecodedEncryptedStateVector,
  DecodedEncryptedSyncStep2,
  DecodedEncryptedUpdatePayload,
  EncryptedStateVector,
  EncryptedSyncStep2,
  EncryptedUpdatePayload,
} from "./encoding";
import {
  decodeEncryptedUpdate,
  decodeFromStateVector,
  decodeFromSyncStep2,
  encodeEncryptedUpdate,
  encodeEncryptedUpdateMessages,
  encodeToStateVector,
  encodeToSyncStep2,
  getEmptyEncryptedUpdate,
  getEmptyEncryptedStateVector,
  getEmptyEncryptedSyncStep2,
} from "./encoding";
import type { ClientId, Counter, LamportClockValue } from "./lamport-clock";

describe("protocol encryption encoding", () => {
  describe("state vector encoding/decoding", () => {
    it("should encode and decode empty state vector", () => {
      const emptyState: DecodedEncryptedStateVector = { clocks: new Map() };
      const encoded = encodeToStateVector(emptyState);
      const decoded = decodeFromStateVector(encoded);

      expect(decoded.clocks.size).toBe(0);
    });

    it("should encode and decode state vector with clocks", () => {
      const clocks = new Map<ClientId, Counter>([
        [1, 5],
        [2, 10],
        [3, 15],
      ]);
      const state: DecodedEncryptedStateVector = { clocks };
      const encoded = encodeToStateVector(state);
      const decoded = decodeFromStateVector(encoded);

      expect(decoded.clocks.size).toBe(3);
      expect(decoded.clocks.get(1)).toBe(5);
      expect(decoded.clocks.get(2)).toBe(10);
      expect(decoded.clocks.get(3)).toBe(15);
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
      expect(decoded.clocks.size).toBe(0);
    });
  });

  describe("encrypted update encoding/decoding", () => {
    it("should encode and decode empty update messages", () => {
      const emptyMessages: DecodedEncryptedUpdatePayload[] = [];
      const encoded = encodeEncryptedUpdateMessages(emptyMessages);
      const decoded = decodeEncryptedUpdate(encoded);

      expect(decoded.length).toBe(0);
    });

    it("should encode and decode single update message", () => {
      const testUpdate = new Uint8Array([1, 2, 3, 4, 5]) as EncryptedUpdate;
      const timestamp: LamportClockValue = [1, 5];
      const message: DecodedEncryptedUpdatePayload = {
        id: "dGVzdC1tZXNzYWdlLWlk", // base64 encoded "test-message-id"
        timestamp,
        payload: testUpdate,
      };

      const encoded = encodeEncryptedUpdateMessages([message]);
      const decoded = decodeEncryptedUpdate(encoded);

      expect(decoded.length).toBe(1);
      expect(decoded[0].id).toBe("dGVzdC1tZXNzYWdlLWlk");
      expect(decoded[0].timestamp).toEqual(timestamp);
      expect(decoded[0].payload).toEqual(testUpdate);
    });

    it("should encode and decode multiple update messages", () => {
      const messages: DecodedEncryptedUpdatePayload[] = [
        {
          id: "bXNnMQ==", // base64 encoded "msg1"
          timestamp: [1, 5],
          payload: new Uint8Array([1, 2, 3]) as EncryptedUpdate,
        },
        {
          id: "bXNnMg==", // base64 encoded "msg2"
          timestamp: [2, 10],
          payload: new Uint8Array([4, 5, 6]) as EncryptedUpdate,
        },
      ];

      const encoded = encodeEncryptedUpdateMessages(messages);
      const decoded = decodeEncryptedUpdate(encoded);

      expect(decoded.length).toBe(2);
      expect(decoded[0].id).toBe("bXNnMQ==");
      expect(decoded[1].id).toBe("bXNnMg==");
    });

    it("should encode single encrypted update", () => {
      const testUpdate = new Uint8Array([1, 2, 3, 4, 5]) as EncryptedUpdate;
      const timestamp: LamportClockValue = [1, 5];

      const encoded = encodeEncryptedUpdate(testUpdate, timestamp);
      const decoded = decodeEncryptedUpdate(encoded);

      expect(decoded.length).toBe(1);
      expect(decoded[0].timestamp).toEqual(timestamp);
      expect(decoded[0].payload).toEqual(testUpdate);
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
      expect(decoded.length).toBe(0);
    });
  });

  describe("sync step 2 encoding/decoding", () => {
    it("should encode and decode empty sync step 2", () => {
      const emptySync: DecodedEncryptedSyncStep2 = { messages: [] };
      const encoded = encodeToSyncStep2(emptySync);
      const decoded = decodeFromSyncStep2(encoded);

      expect(decoded.messages.length).toBe(0);
    });

    it("should encode and decode sync step 2 with messages", () => {
      const messages: DecodedEncryptedUpdatePayload[] = [
        {
          id: "msg1",
          timestamp: [1, 5],
          payload: new Uint8Array([1, 2, 3]) as EncryptedUpdate,
        },
        {
          id: "msg2",
          timestamp: [2, 10],
          payload: new Uint8Array([4, 5, 6]) as EncryptedUpdate,
        },
      ];
      const sync: DecodedEncryptedSyncStep2 = { messages };

      const encoded = encodeToSyncStep2(sync);
      const decoded = decodeFromSyncStep2(encoded);

      expect(decoded.messages.length).toBe(2);
      expect(decoded.messages[0].id).toBe("msg1");
      expect(decoded.messages[1].id).toBe("msg2");
    });

    it("should handle client id mapping correctly", () => {
      const messages: DecodedEncryptedUpdatePayload[] = [
        {
          id: "msg1",
          timestamp: [100, 5],
          payload: new Uint8Array([1, 2, 3]) as EncryptedUpdate,
        },
        {
          id: "msg2",
          timestamp: [100, 10], // Same client id
          payload: new Uint8Array([4, 5, 6]) as EncryptedUpdate,
        },
      ];
      const sync: DecodedEncryptedSyncStep2 = { messages };

      const encoded = encodeToSyncStep2(sync);
      const decoded = decodeFromSyncStep2(encoded);

      expect(decoded.messages.length).toBe(2);
      expect(decoded.messages[0].timestamp[0]).toBe(100);
      expect(decoded.messages[1].timestamp[0]).toBe(100);
    });

    it("should throw error for invalid sync step 2 version", () => {
      const invalidData = new Uint8Array([1, 0, 0]); // version 1 instead of 0
      expect(() =>
        decodeFromSyncStep2(invalidData as EncryptedSyncStep2),
      ).toThrow("Failed to decode encrypted sync step 2 message");
    });

    it("should return empty sync step 2", () => {
      const empty = getEmptyEncryptedSyncStep2();
      const decoded = decodeFromSyncStep2(empty);
      expect(decoded.messages.length).toBe(0);
    });
  });
});
