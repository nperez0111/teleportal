import { describe, expect, it } from "bun:test";
import { EncryptedBinary } from "../../../encryption-key";
import type { EncryptedMessageId } from "./encoding";
import { decodeFromStateVector, decodeFromSyncStep2 } from "./encoding";
import type { SeenMessageMapping } from "./sync";
import {
  getDecodedStateVector,
  getDecodedSyncStep2,
  getEncryptedStateVector,
  getEncryptedSyncStep2,
} from "./sync";

describe("sync functions", () => {
  describe("getDecodedStateVector", () => {
    it("should return empty state vector for empty seen messages", () => {
      const seenMessages: SeenMessageMapping = {};
      const stateVector = getDecodedStateVector(seenMessages);

      expect(stateVector.clocks.size).toBe(0);
    });

    it("should return state vector with highest counters per client", () => {
      const seenMessages: SeenMessageMapping = {
        1: { 5: "msg1", 10: "msg2", 3: "msg3" },
        2: { 7: "msg4", 2: "msg5" },
      };
      const stateVector = getDecodedStateVector(seenMessages);

      expect(stateVector.clocks.size).toBe(2);
      expect(stateVector.clocks.get(1)).toBe(10); // highest counter for client 1
      expect(stateVector.clocks.get(2)).toBe(7); // highest counter for client 2
    });

    it("should handle single client with multiple messages", () => {
      const seenMessages: SeenMessageMapping = {
        42: { 1: "msg1", 5: "msg2", 3: "msg3", 8: "msg4" },
      };
      const stateVector = getDecodedStateVector(seenMessages);

      expect(stateVector.clocks.size).toBe(1);
      expect(stateVector.clocks.get(42)).toBe(8); // highest counter
    });

    it("should handle multiple clients with single messages", () => {
      const seenMessages: SeenMessageMapping = {
        1: { 5: "msg1" },
        2: { 10: "msg2" },
        3: { 3: "msg3" },
      };
      const stateVector = getDecodedStateVector(seenMessages);

      expect(stateVector.clocks.size).toBe(3);
      expect(stateVector.clocks.get(1)).toBe(5);
      expect(stateVector.clocks.get(2)).toBe(10);
      expect(stateVector.clocks.get(3)).toBe(3);
    });

    it("should handle large client ids and counters", () => {
      const seenMessages: SeenMessageMapping = {
        999999: { 123456: "msg1", 789012: "msg2" },
        1000000: { 654321: "msg3" },
      };
      const stateVector = getDecodedStateVector(seenMessages);

      expect(stateVector.clocks.size).toBe(2);
      expect(stateVector.clocks.get(999999)).toBe(789012);
      expect(stateVector.clocks.get(1000000)).toBe(654321);
    });
  });

  describe("getEncryptedStateVector", () => {
    it("should encode decoded state vector", () => {
      const seenMessages: SeenMessageMapping = {
        1: { 5: "msg1" },
      };
      const encrypted = getEncryptedStateVector(seenMessages);
      const decoded = decodeFromStateVector(encrypted);

      expect(decoded.clocks.get(1)).toBe(5);
    });

    it("should encode empty state vector", () => {
      const seenMessages: SeenMessageMapping = {};
      const encrypted = getEncryptedStateVector(seenMessages);
      const decoded = decodeFromStateVector(encrypted);

      expect(decoded.clocks.size).toBe(0);
    });

    it("should encode complex state vector", () => {
      const seenMessages: SeenMessageMapping = {
        1: { 5: "msg1", 10: "msg2" },
        2: { 7: "msg3" },
        3: { 1: "msg4", 3: "msg5", 8: "msg6" },
      };
      const encrypted = getEncryptedStateVector(seenMessages);
      const decoded = decodeFromStateVector(encrypted);

      expect(decoded.clocks.get(1)).toBe(10);
      expect(decoded.clocks.get(2)).toBe(7);
      expect(decoded.clocks.get(3)).toBe(8);
    });
  });

  describe("getDecodedSyncStep2", () => {
    it("should return empty sync step 2 for empty seen messages", async () => {
      const seenMessages: SeenMessageMapping = {};
      const getEncryptedMessageUpdate = async (id: EncryptedMessageId) => null;

      const syncStep2 = await getDecodedSyncStep2(
        seenMessages,
        getEncryptedMessageUpdate,
      );

      expect(syncStep2.messages.length).toBe(0);
    });

    it("should return messages not seen by other client", async () => {
      const seenMessages: SeenMessageMapping = {
        1: { 1: "msg1", 2: "msg2", 3: "msg3", 4: "msg4", 5: "msg5" },
      };
      const getEncryptedMessageUpdate = async (id: EncryptedMessageId) => {
        const messages: Record<string, EncryptedBinary> = {
          msg1: new Uint8Array([1]) as EncryptedBinary,
          msg2: new Uint8Array([2]) as EncryptedBinary,
          msg3: new Uint8Array([3]) as EncryptedBinary,
          msg4: new Uint8Array([4]) as EncryptedBinary,
          msg5: new Uint8Array([5]) as EncryptedBinary,
        };
        return messages[id] ?? null;
      };

      // Other client has seen up to counter 2 for client 1
      const syncStep1 = {
        clocks: new Map([[1, 2]]),
      };

      const syncStep2 = await getDecodedSyncStep2(
        seenMessages,
        getEncryptedMessageUpdate,
        syncStep1,
      );

      expect(syncStep2.messages.length).toBe(3);
      const messageIds = syncStep2.messages.map((m) => m.id).sort();
      expect(messageIds).toEqual(["msg3", "msg4", "msg5"]);
    });

    it("should handle consecutive messages efficiently", async () => {
      // Create a large range of consecutive messages
      const seenMessages: SeenMessageMapping = {
        1: Object.fromEntries(
          Array.from({ length: 100 }, (_, i) => [i + 1, `msg${i + 1}`]),
        ),
      };
      const getEncryptedMessageUpdate = async (id: EncryptedMessageId) => {
        return new Uint8Array([1, 2, 3]) as EncryptedBinary;
      };

      // Other client has seen up to counter 50
      const syncStep1 = {
        clocks: new Map([[1, 50]]),
      };

      const syncStep2 = await getDecodedSyncStep2(
        seenMessages,
        getEncryptedMessageUpdate,
        syncStep1,
      );

      expect(syncStep2.messages.length).toBe(50);
    });

    it("should produce same results as non-range-based version", async () => {
      const seenMessages: SeenMessageMapping = {
        1: { 1: "msg1", 2: "msg2", 5: "msg5", 6: "msg6" },
        2: { 3: "msg3", 4: "msg4" },
      };
      const getEncryptedMessageUpdate = async (id: EncryptedMessageId) => {
        const messages: Record<string, EncryptedBinary> = {
          msg1: new Uint8Array([1]) as EncryptedBinary,
          msg2: new Uint8Array([2]) as EncryptedBinary,
          msg3: new Uint8Array([3]) as EncryptedBinary,
          msg4: new Uint8Array([4]) as EncryptedBinary,
          msg5: new Uint8Array([5]) as EncryptedBinary,
          msg6: new Uint8Array([6]) as EncryptedBinary,
        };
        return messages[id] ?? null;
      };

      const syncStep1 = {
        clocks: new Map([
          [1, 1], // Seen up to counter 1 for client 1
          [2, 2], // Seen up to counter 2 for client 2
        ]),
      };

      const rangeBased = await getDecodedSyncStep2(
        seenMessages,
        getEncryptedMessageUpdate,
        syncStep1,
      );
      const standard = await getDecodedSyncStep2(
        seenMessages,
        getEncryptedMessageUpdate,
        syncStep1,
      );

      // Should have same number of messages
      expect(rangeBased.messages.length).toBe(standard.messages.length);

      // Should have same message IDs (order may differ)
      const rangeBasedIds = rangeBased.messages.map((m) => m.id).sort();
      const standardIds = standard.messages.map((m) => m.id).sort();
      expect(rangeBasedIds).toEqual(standardIds);
    });
  });

  describe("getEncryptedSyncStep2", () => {
    it("should encode decoded sync step 2 using range-based reconciliation", async () => {
      const seenMessages: SeenMessageMapping = {
        1: { 1: "msg1", 2: "msg2", 3: "msg3" },
      };
      const getEncryptedMessageUpdate = async (id: EncryptedMessageId) => {
        const messages: Record<string, EncryptedBinary> = {
          msg1: new Uint8Array([1]) as EncryptedBinary,
          msg2: new Uint8Array([2]) as EncryptedBinary,
          msg3: new Uint8Array([3]) as EncryptedBinary,
        };
        return messages[id] ?? null;
      };

      const encrypted = await getEncryptedSyncStep2(
        seenMessages,
        getEncryptedMessageUpdate,
      );
      const decoded = decodeFromSyncStep2(encrypted);

      expect(decoded.messages.length).toBe(3);
    });

    it("should handle empty sync step 2", async () => {
      const seenMessages: SeenMessageMapping = {};
      const getEncryptedMessageUpdate = async (id: EncryptedMessageId) => null;

      const encrypted = await getEncryptedSyncStep2(
        seenMessages,
        getEncryptedMessageUpdate,
      );
      const decoded = decodeFromSyncStep2(encrypted);

      expect(decoded.messages.length).toBe(0);
    });
  });
});
