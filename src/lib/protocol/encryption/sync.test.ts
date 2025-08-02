import { describe, expect, it } from "bun:test";
import { EncryptedUpdate } from "../../../encryption-key";
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
        1: { 5: "msg1", 10: "msg2" },
      };
      const getEncryptedMessageUpdate = async (id: EncryptedMessageId) => {
        if (id === "msg1") return new Uint8Array([1, 2, 3]) as EncryptedUpdate;
        if (id === "msg2") return new Uint8Array([4, 5, 6]) as EncryptedUpdate;
        return null;
      };

      // Other client has seen up to counter 3 for client 1
      const syncStep1 = {
        clocks: new Map([[1, 3]]),
      };

      const syncStep2 = await getDecodedSyncStep2(
        seenMessages,
        getEncryptedMessageUpdate,
        syncStep1,
      );

      expect(syncStep2.messages.length).toBe(2);
      expect(syncStep2.messages[0].id).toBe("msg1");
      expect(syncStep2.messages[1].id).toBe("msg2");
    });

    it("should filter out messages already seen by other client", async () => {
      const seenMessages: SeenMessageMapping = {
        1: { 5: "msg1", 10: "msg2" },
      };
      const getEncryptedMessageUpdate = async (id: EncryptedMessageId) => {
        if (id === "msg1") return new Uint8Array([1, 2, 3]) as EncryptedUpdate;
        if (id === "msg2") return new Uint8Array([4, 5, 6]) as EncryptedUpdate;
        return null;
      };

      // Other client has seen up to counter 7 for client 1
      const syncStep1 = {
        clocks: new Map([[1, 7]]),
      };

      const syncStep2 = await getDecodedSyncStep2(
        seenMessages,
        getEncryptedMessageUpdate,
        syncStep1,
      );

      expect(syncStep2.messages.length).toBe(1);
      expect(syncStep2.messages[0].id).toBe("msg2"); // only msg2 has counter > 7
    });

    it("should handle null updates from getEncryptedMessageUpdate", async () => {
      const seenMessages: SeenMessageMapping = {
        1: { 5: "msg1" },
      };
      const getEncryptedMessageUpdate = async (id: EncryptedMessageId) => null;

      const syncStep2 = await getDecodedSyncStep2(
        seenMessages,
        getEncryptedMessageUpdate,
      );

      expect(syncStep2.messages.length).toBe(0);
    });

    it("should handle multiple clients in seen messages", async () => {
      const seenMessages: SeenMessageMapping = {
        1: { 5: "msg1", 10: "msg2" },
        2: { 3: "msg3", 7: "msg4" },
      };
      const getEncryptedMessageUpdate = async (id: EncryptedMessageId) => {
        if (id === "msg1") return new Uint8Array([1, 2, 3]) as EncryptedUpdate;
        if (id === "msg2") return new Uint8Array([4, 5, 6]) as EncryptedUpdate;
        if (id === "msg3") return new Uint8Array([7, 8, 9]) as EncryptedUpdate;
        if (id === "msg4")
          return new Uint8Array([10, 11, 12]) as EncryptedUpdate;
        return null;
      };

      // Other client has seen up to counter 3 for client 1 and 5 for client 2
      const syncStep1 = {
        clocks: new Map([
          [1, 3],
          [2, 5],
        ]),
      };

      const syncStep2 = await getDecodedSyncStep2(
        seenMessages,
        getEncryptedMessageUpdate,
        syncStep1,
      );

      expect(syncStep2.messages.length).toBe(3);
      // msg1 (counter 5 > 3), msg2 (counter 10 > 3), msg4 (counter 7 > 5)
      // msg3 (counter 3 <= 5) should be filtered out
      const messageIds = syncStep2.messages.map((m) => m.id).sort();
      expect(messageIds).toEqual(["msg1", "msg2", "msg4"]);
    });

    it("should handle empty sync step 1 (no previous sync)", async () => {
      const seenMessages: SeenMessageMapping = {
        1: { 5: "msg1", 10: "msg2" },
      };
      const getEncryptedMessageUpdate = async (id: EncryptedMessageId) => {
        if (id === "msg1") return new Uint8Array([1, 2, 3]) as EncryptedUpdate;
        if (id === "msg2") return new Uint8Array([4, 5, 6]) as EncryptedUpdate;
        return null;
      };

      // No previous sync (empty state vector)
      const syncStep1 = {
        clocks: new Map(),
      };

      const syncStep2 = await getDecodedSyncStep2(
        seenMessages,
        getEncryptedMessageUpdate,
        syncStep1,
      );

      expect(syncStep2.messages.length).toBe(2);
      expect(syncStep2.messages[0].id).toBe("msg1");
      expect(syncStep2.messages[1].id).toBe("msg2");
    });

    it("should handle client not in sync step 1", async () => {
      const seenMessages: SeenMessageMapping = {
        1: { 5: "msg1" },
        2: { 3: "msg2" },
      };
      const getEncryptedMessageUpdate = async (id: EncryptedMessageId) => {
        if (id === "msg1") return new Uint8Array([1, 2, 3]) as EncryptedUpdate;
        if (id === "msg2") return new Uint8Array([4, 5, 6]) as EncryptedUpdate;
        return null;
      };

      // Other client only knows about client 1
      const syncStep1 = {
        clocks: new Map([[1, 3]]),
      };

      const syncStep2 = await getDecodedSyncStep2(
        seenMessages,
        getEncryptedMessageUpdate,
        syncStep1,
      );

      expect(syncStep2.messages.length).toBe(2);
      // Both messages should be included since client 2 is not in sync step 1
      expect(syncStep2.messages[0].id).toBe("msg1");
      expect(syncStep2.messages[1].id).toBe("msg2");
    });

    it("should handle partial null updates", async () => {
      const seenMessages: SeenMessageMapping = {
        1: { 5: "msg1", 10: "msg2" },
      };
      const getEncryptedMessageUpdate = async (id: EncryptedMessageId) => {
        if (id === "msg1") return new Uint8Array([1, 2, 3]) as EncryptedUpdate;
        if (id === "msg2") return null; // This message is not available
        return null;
      };

      const syncStep2 = await getDecodedSyncStep2(
        seenMessages,
        getEncryptedMessageUpdate,
      );

      expect(syncStep2.messages.length).toBe(1);
      expect(syncStep2.messages[0].id).toBe("msg1");
    });
  });

  describe("getEncryptedSyncStep2", () => {
    it("should encode decoded sync step 2", async () => {
      const seenMessages: SeenMessageMapping = {
        1: { 5: "msg1" },
      };
      const getEncryptedMessageUpdate = async (id: EncryptedMessageId) => {
        if (id === "msg1") return new Uint8Array([1, 2, 3]) as EncryptedUpdate;
        return null;
      };

      const encrypted = await getEncryptedSyncStep2(
        seenMessages,
        getEncryptedMessageUpdate,
      );
      const decoded = decodeFromSyncStep2(encrypted);

      expect(decoded.messages.length).toBe(1);
      expect(decoded.messages[0].id).toBe("msg1");
    });

    it("should encode empty sync step 2", async () => {
      const seenMessages: SeenMessageMapping = {};
      const getEncryptedMessageUpdate = async (id: EncryptedMessageId) => null;

      const encrypted = await getEncryptedSyncStep2(
        seenMessages,
        getEncryptedMessageUpdate,
      );
      const decoded = decodeFromSyncStep2(encrypted);

      expect(decoded.messages.length).toBe(0);
    });

    it("should encode complex sync step 2", async () => {
      const seenMessages: SeenMessageMapping = {
        1: { 5: "msg1", 10: "msg2" },
        2: { 3: "msg3" },
      };
      const getEncryptedMessageUpdate = async (id: EncryptedMessageId) => {
        if (id === "msg1") return new Uint8Array([1, 2, 3]) as EncryptedUpdate;
        if (id === "msg2") return new Uint8Array([4, 5, 6]) as EncryptedUpdate;
        if (id === "msg3") return new Uint8Array([7, 8, 9]) as EncryptedUpdate;
        return null;
      };

      const encrypted = await getEncryptedSyncStep2(
        seenMessages,
        getEncryptedMessageUpdate,
      );
      const decoded = decodeFromSyncStep2(encrypted);

      expect(decoded.messages.length).toBe(3);
      const messageIds = decoded.messages.map((m) => m.id).sort();
      expect(messageIds).toEqual(["msg1", "msg2", "msg3"]);
    });
  });
});
