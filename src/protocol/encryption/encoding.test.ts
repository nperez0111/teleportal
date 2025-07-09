import { describe, expect, it } from "bun:test";
import { digest } from "lib0/hash/sha256";
import type { Update } from "teleportal";
import {
  appendFauxUpdateList,
  decodeFauxStateVector,
  decodeFauxUpdateList,
  encodeFauxStateVector,
  encodeFauxUpdateList,
  getEmptyFauxUpdateList,
  messageIdToString,
  stringToMessageId,
  type DecodedFauxStateVector,
  type DecodedUpdate,
  type DecodedUpdateList,
} from "./encoding";

function createUpdate(data: Uint8Array): Update {
  return data as Update;
}

function createMessageId(data: Uint8Array): Uint8Array {
  return digest(data);
}

describe("e2e encoding", () => {
  describe("State Vector Encoding/Decoding", () => {
    it("should encode and decode a state vector with single message ID", () => {
      const messageId = createMessageId(new Uint8Array([1, 2, 3]));
      const original: DecodedFauxStateVector = {
        messageIds: [messageId],
      };

      const encoded = encodeFauxStateVector(original);
      const decoded = decodeFauxStateVector(encoded);

      expect(decoded).toEqual(original);
    });

    it("should encode and decode a state vector with multiple message IDs", () => {
      const messageIds = [
        createMessageId(new Uint8Array([1])),
        createMessageId(new Uint8Array([2])),
        createMessageId(new Uint8Array([3])),
        createMessageId(new Uint8Array([4])),
      ];
      const original: DecodedFauxStateVector = {
        messageIds,
      };

      const encoded = encodeFauxStateVector(original);
      const decoded = decodeFauxStateVector(encoded);

      expect(decoded).toEqual(original);
    });

    it("should encode and decode an empty state vector", () => {
      const original: DecodedFauxStateVector = {
        messageIds: [],
      };

      const encoded = encodeFauxStateVector(original);
      const decoded = decodeFauxStateVector(encoded);

      expect(decoded).toEqual(original);
    });

    it("should handle large number of message IDs", () => {
      const messageIds = Array.from({ length: 1000 }, (_, i) => 
        createMessageId(new Uint8Array([i % 256]))
      );
      const original: DecodedFauxStateVector = {
        messageIds,
      };

      const encoded = encodeFauxStateVector(original);
      const decoded = decodeFauxStateVector(encoded);

      expect(decoded).toEqual(original);
      expect(decoded.messageIds.length).toBe(1000);
    });
  });

  describe("Empty Update List", () => {
    it("should create an empty update list", () => {
      const empty = getEmptyFauxUpdateList();
      const decoded = decodeFauxUpdateList(empty);

      expect(decoded).toEqual([]);
      expect(decoded.length).toBe(0);
    });

    it("should decode empty list correctly", () => {
      const empty = getEmptyFauxUpdateList();
      const decoded = decodeFauxUpdateList(empty);

      expect(Array.isArray(decoded)).toBe(true);
      expect(decoded.length).toBe(0);
    });
  });

  describe("Update List Encoding/Decoding", () => {
    it("should encode and decode a single update", () => {
      const updateData = new Uint8Array([1, 2, 3, 4, 5]);
      const original: DecodedUpdateList = [
        {
          messageId: createMessageId(updateData),
          update: createUpdate(updateData),
        },
      ];

      const encoded = encodeFauxUpdateList(original);
      const decoded = decodeFauxUpdateList(encoded);

      expect(decoded).toEqual(original);
      expect(decoded.length).toBe(1);
    });

    it("should encode and decode multiple updates", () => {
      const updateData1 = new Uint8Array([1, 2, 3]);
      const updateData2 = new Uint8Array([4, 5, 6]);
      const updateData3 = new Uint8Array([7, 8, 9]);
      
      const original: DecodedUpdateList = [
        {
          messageId: createMessageId(updateData1),
          update: createUpdate(updateData1),
        },
        {
          messageId: createMessageId(updateData2),
          update: createUpdate(updateData2),
        },
        {
          messageId: createMessageId(updateData3),
          update: createUpdate(updateData3),
        },
      ];

      const encoded = encodeFauxUpdateList(original);
      const decoded = decodeFauxUpdateList(encoded);

      expect(decoded).toEqual(original);
      expect(decoded.length).toBe(3);
    });

    it("should handle empty updates", () => {
      const emptyUpdate = new Uint8Array(0);
      const original: DecodedUpdateList = [
        {
          messageId: createMessageId(emptyUpdate),
          update: createUpdate(emptyUpdate),
        },
      ];

      const encoded = encodeFauxUpdateList(original);
      const decoded = decodeFauxUpdateList(encoded);

      expect(decoded).toEqual(original);
      expect(decoded[0].update.length).toBe(0);
    });

    it("should handle large updates", () => {
      const largeUpdate = new Uint8Array(1000);
      for (let i = 0; i < largeUpdate.length; i++) {
        largeUpdate[i] = i % 256;
      }

      const original: DecodedUpdateList = [
        {
          messageId: createMessageId(largeUpdate),
          update: createUpdate(largeUpdate),
        },
      ];

      const encoded = encodeFauxUpdateList(original);
      const decoded = decodeFauxUpdateList(encoded);

      expect(decoded).toEqual(original);
      expect(decoded[0].update.length).toBe(1000);
    });

    it("should handle mixed update sizes", () => {
      const update1 = new Uint8Array([1]);
      const update2 = new Uint8Array([1, 2, 3, 4, 5]);
      const update3 = new Uint8Array(100);
      
      const original: DecodedUpdateList = [
        {
          messageId: createMessageId(update1),
          update: createUpdate(update1),
        },
        {
          messageId: createMessageId(update2),
          update: createUpdate(update2),
        },
        {
          messageId: createMessageId(update3),
          update: createUpdate(update3),
        },
      ];

      const encoded = encodeFauxUpdateList(original);
      const decoded = decodeFauxUpdateList(encoded);

      expect(decoded).toEqual(original);
      expect(decoded[0].update.length).toBe(1);
      expect(decoded[1].update.length).toBe(5);
      expect(decoded[2].update.length).toBe(100);
    });
  });

  describe("Append Update List", () => {
    it("should append updates to an empty list", () => {
      const empty = getEmptyFauxUpdateList();
      const updateData1 = new Uint8Array([1, 2, 3]);
      const updateData2 = new Uint8Array([4, 5, 6]);
      
      const newUpdates: DecodedUpdate[] = [
        {
          messageId: createMessageId(updateData1),
          update: createUpdate(updateData1),
        },
        {
          messageId: createMessageId(updateData2),
          update: createUpdate(updateData2),
        },
      ];

      const appended = appendFauxUpdateList(empty, newUpdates);
      const decoded = decodeFauxUpdateList(appended);

      expect(decoded).toEqual(newUpdates);
      expect(decoded.length).toBe(2);
    });

    it("should prepend updates to existing list (newer updates first)", () => {
      const existingData1 = new Uint8Array([1, 2, 3]);
      const existingData2 = new Uint8Array([4, 5, 6]);
      const newData1 = new Uint8Array([7, 8, 9]);
      const newData2 = new Uint8Array([10, 11, 12]);
      
      const existing: DecodedUpdateList = [
        {
          messageId: createMessageId(existingData1),
          update: createUpdate(existingData1),
        },
        {
          messageId: createMessageId(existingData2),
          update: createUpdate(existingData2),
        },
      ];

      const newUpdates: DecodedUpdate[] = [
        {
          messageId: createMessageId(newData1),
          update: createUpdate(newData1),
        },
        {
          messageId: createMessageId(newData2),
          update: createUpdate(newData2),
        },
      ];

      const encoded = encodeFauxUpdateList(existing);
      const appended = appendFauxUpdateList(encoded, newUpdates);
      const decoded = decodeFauxUpdateList(appended);

      // New updates are prepended (come first)
      const expected = [...newUpdates, ...existing];
      expect(decoded).toEqual(expected);
      expect(decoded.length).toBe(4);
    });

    it("should handle prepending to single item list", () => {
      const existingData = new Uint8Array([1]);
      const newData = new Uint8Array([2]);
      
      const existing: DecodedUpdateList = [
        {
          messageId: createMessageId(existingData),
          update: createUpdate(existingData),
        },
      ];

      const newUpdates: DecodedUpdate[] = [
        {
          messageId: createMessageId(newData),
          update: createUpdate(newData),
        },
      ];

      const encoded = encodeFauxUpdateList(existing);
      const appended = appendFauxUpdateList(encoded, newUpdates);
      const decoded = decodeFauxUpdateList(appended);

      // New updates are prepended
      const expected = [...newUpdates, ...existing];
      expect(decoded).toEqual(expected);
      expect(decoded.length).toBe(2);
    });

    it("should handle appending empty array", () => {
      const existingData = new Uint8Array([1, 2, 3]);
      const existing: DecodedUpdateList = [
        {
          messageId: createMessageId(existingData),
          update: createUpdate(existingData),
        },
      ];

      const encoded = encodeFauxUpdateList(existing);
      const appended = appendFauxUpdateList(encoded, []);
      const decoded = decodeFauxUpdateList(appended);

      expect(decoded).toEqual(existing);
      expect(decoded.length).toBe(1);
    });

    it("should handle prepending multiple items", () => {
      const existingData = new Uint8Array([1]);
      const newData1 = new Uint8Array([2]);
      const newData2 = new Uint8Array([3]);
      const newData3 = new Uint8Array([4]);
      
      const existing: DecodedUpdateList = [
        {
          messageId: createMessageId(existingData),
          update: createUpdate(existingData),
        },
      ];

      const newUpdates: DecodedUpdate[] = [
        {
          messageId: createMessageId(newData1),
          update: createUpdate(newData1),
        },
        {
          messageId: createMessageId(newData2),
          update: createUpdate(newData2),
        },
        {
          messageId: createMessageId(newData3),
          update: createUpdate(newData3),
        },
      ];

      const encoded = encodeFauxUpdateList(existing);
      const appended = appendFauxUpdateList(encoded, newUpdates);
      const decoded = decodeFauxUpdateList(appended);

      // New updates are prepended
      const expected = [...newUpdates, ...existing];
      expect(decoded).toEqual(expected);
      expect(decoded.length).toBe(4);
    });
  });

  describe("Round-trip Consistency", () => {
    it("should maintain consistency through multiple encode/decode cycles", () => {
      const updateData1 = new Uint8Array([1, 2, 3, 4, 5]);
      const updateData2 = new Uint8Array([6, 7, 8, 9, 10]);
      
      const original: DecodedUpdateList = [
        {
          messageId: createMessageId(updateData1),
          update: createUpdate(updateData1),
        },
        {
          messageId: createMessageId(updateData2),
          update: createUpdate(updateData2),
        },
      ];

      // Multiple encode/decode cycles
      let current = original;
      for (let i = 0; i < 5; i++) {
        const encoded = encodeFauxUpdateList(current);
        const decoded = decodeFauxUpdateList(encoded);
        expect(decoded).toEqual(original);
        current = decoded;
      }
    });

    it("should maintain consistency for state vectors through multiple cycles", () => {
      const original: DecodedFauxStateVector = {
        messageIds: [
          createMessageId(new Uint8Array([1, 2, 3, 4, 5])),
          createMessageId(new Uint8Array([6, 7, 8, 9, 10])),
        ],
      };

      // Multiple encode/decode cycles
      let current = original;
      for (let i = 0; i < 5; i++) {
        const encoded = encodeFauxStateVector(current);
        const decoded = decodeFauxStateVector(encoded);
        expect(decoded).toEqual(original);
        current = decoded;
      }
    });
  });

  describe("Edge Cases", () => {
    it("should handle very large update data", () => {
      const veryLargeUpdate = new Uint8Array(10000);
      for (let i = 0; i < veryLargeUpdate.length; i++) {
        veryLargeUpdate[i] = i % 256;
      }

      const original: DecodedUpdateList = [
        {
          messageId: createMessageId(veryLargeUpdate),
          update: createUpdate(veryLargeUpdate),
        },
      ];

      const encoded = encodeFauxUpdateList(original);
      const decoded = decodeFauxUpdateList(encoded);

      expect(decoded).toEqual(original);
      expect(decoded[0].update.length).toBe(10000);
    });

    it("should handle many small updates", () => {
      const manyUpdates: DecodedUpdate[] = [];
      for (let i = 0; i < 100; i++) {
        const updateData = new Uint8Array([i]);
        manyUpdates.push({
          messageId: createMessageId(updateData),
          update: createUpdate(updateData),
        });
      }

      const encoded = encodeFauxUpdateList(manyUpdates);
      const decoded = decodeFauxUpdateList(encoded);

      expect(decoded).toEqual(manyUpdates);
      expect(decoded.length).toBe(100);
    });
  });

  describe("Sync Step 1 Integration", () => {
    it("should compute correct diff when client has some messages", () => {
      // Create message data
      const msgData1 = new Uint8Array([1]);
      const msgData2 = new Uint8Array([2]);
      const msgData3 = new Uint8Array([3]);
      const msgData4 = new Uint8Array([4]);
      const msgData5 = new Uint8Array([5]);
      
      // Simulate server state with 5 messages
      const serverUpdates: DecodedUpdateList = [
        {
          messageId: createMessageId(msgData1),
          update: createUpdate(msgData1),
        },
        {
          messageId: createMessageId(msgData2), 
          update: createUpdate(msgData2),
        },
        {
          messageId: createMessageId(msgData3),
          update: createUpdate(msgData3),
        },
        {
          messageId: createMessageId(msgData4),
          update: createUpdate(msgData4),
        },
        {
          messageId: createMessageId(msgData5),
          update: createUpdate(msgData5),
        },
      ];

      // Client has messages 1, 2, and 4 (missing 3 and 5)
      const clientMessageIds = [
        createMessageId(msgData1),
        createMessageId(msgData2),
        createMessageId(msgData4),
      ];
      const clientStateVector: DecodedFauxStateVector = {
        messageIds: clientMessageIds,
      };

      // Simulate server computing diff (convert to strings for Set operations)
      const clientMessageIdSet = new Set(
        clientStateVector.messageIds.map(messageIdToString)
      );
      const expectedDiff = serverUpdates.filter(
        (update) => !clientMessageIdSet.has(messageIdToString(update.messageId))
      );

      // Should return messages 3 and 5
      expect(expectedDiff).toEqual([
        {
          messageId: createMessageId(msgData3),
          update: createUpdate(msgData3),
        },
        {
          messageId: createMessageId(msgData5), 
          update: createUpdate(msgData5),
        },
      ]);
      expect(expectedDiff.length).toBe(2);
    });

    it("should return all messages when client has none", () => {
      const msgData1 = new Uint8Array([1]);
      const msgData2 = new Uint8Array([2]);
      
      const serverUpdates: DecodedUpdateList = [
        {
          messageId: createMessageId(msgData1),
          update: createUpdate(msgData1),
        },
        {
          messageId: createMessageId(msgData2),
          update: createUpdate(msgData2),
        },
      ];

      // Client has no messages
      const clientStateVector: DecodedFauxStateVector = {
        messageIds: [],
      };

      const clientMessageIdSet = new Set(
        clientStateVector.messageIds.map(messageIdToString)
      );
      const expectedDiff = serverUpdates.filter(
        (update) => !clientMessageIdSet.has(messageIdToString(update.messageId))
      );

      // Should return all messages
      expect(expectedDiff).toEqual(serverUpdates);
      expect(expectedDiff.length).toBe(2);
    });

    it("should return no messages when client has all", () => {
      const msgData1 = new Uint8Array([1]);
      const msgData2 = new Uint8Array([2]);
      
      const serverUpdates: DecodedUpdateList = [
        {
          messageId: createMessageId(msgData1),
          update: createUpdate(msgData1),
        },
        {
          messageId: createMessageId(msgData2),
          update: createUpdate(msgData2),
        },
      ];

      // Client has all messages
      const clientStateVector: DecodedFauxStateVector = {
        messageIds: [createMessageId(msgData1), createMessageId(msgData2)],
      };

      const clientMessageIdSet = new Set(
        clientStateVector.messageIds.map(messageIdToString)
      );
      const expectedDiff = serverUpdates.filter(
        (update) => !clientMessageIdSet.has(messageIdToString(update.messageId))
      );

      // Should return no messages
      expect(expectedDiff).toEqual([]);
      expect(expectedDiff.length).toBe(0);
    });

    it("should handle client having extra message IDs gracefully", () => {
      const msgData1 = new Uint8Array([1]);
      const msgData2 = new Uint8Array([2]);
      const extraData1 = new Uint8Array([99]);
      const extraData2 = new Uint8Array([100]);
      
      const serverUpdates: DecodedUpdateList = [
        {
          messageId: createMessageId(msgData1),
          update: createUpdate(msgData1),
        },
        {
          messageId: createMessageId(msgData2),
          update: createUpdate(msgData2),
        },
      ];

      // Client claims to have messages that don't exist on server
      const clientStateVector: DecodedFauxStateVector = {
        messageIds: [
          createMessageId(msgData1), 
          createMessageId(msgData2), 
          createMessageId(extraData1), 
          createMessageId(extraData2)
        ],
      };

      const clientMessageIdSet = new Set(
        clientStateVector.messageIds.map(messageIdToString)
      );
      const expectedDiff = serverUpdates.filter(
        (update) => !clientMessageIdSet.has(messageIdToString(update.messageId))
      );

      // Should return no messages (client has all that exist)
      expect(expectedDiff).toEqual([]);
      expect(expectedDiff.length).toBe(0);
    });

    it("should handle round-trip sync step 1 encoding", () => {
      // Client state vector with multiple message IDs
      const clientMessageIds = [
        createMessageId(new Uint8Array([1])),
        createMessageId(new Uint8Array([3])),
        createMessageId(new Uint8Array([5])),
      ];
      const clientStateVector: DecodedFauxStateVector = {
        messageIds: clientMessageIds,
      };

      // Encode state vector (as client would send to server)
      const encodedStateVector = encodeFauxStateVector(clientStateVector);

      // Decode on server side
      const decodedOnServer = decodeFauxStateVector(encodedStateVector);

      // Should match original
      expect(decodedOnServer).toEqual(clientStateVector);
      expect(decodedOnServer.messageIds).toEqual(clientMessageIds);
    });
  });
});
