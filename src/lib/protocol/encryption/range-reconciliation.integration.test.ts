import { describe, expect, it } from "bun:test";
import { digest } from "lib0/hash/sha256";
import { toBase64 } from "lib0/buffer";
import { EncryptedBinary } from "../../../encryption-key";
import { LamportClock } from "./lamport-clock";
import type { EncryptedMessageId } from "./encoding";
import { decodeFromStateVector } from "./encoding";
import type { SeenMessageMapping } from "./sync";
import { getDecodedSyncStep2, getEncryptedStateVector } from "./sync";
import {
  computeSetDifference,
  fromRangeBased,
  mergeRangeBased,
  toRangeBased,
} from "./range-reconciliation";

/**
 * Helper to create a message ID from a payload (same as the real implementation)
 */
function createMessageId(payload: EncryptedBinary): EncryptedMessageId {
  return toBase64(digest(payload));
}

/**
 * Helper to create a realistic encrypted message payload
 */
function createPayload(content: string): EncryptedBinary {
  // In real usage, this would be encrypted, but for testing we'll use the content directly
  return new TextEncoder().encode(content) as EncryptedBinary;
}

describe("range-reconciliation integration tests", () => {
  describe("real-world synchronization scenarios", () => {
    it("should synchronize two clients with consecutive message streams", async () => {
      // Simulate Client A (clientId: 1) creating 10 consecutive messages
      const clientA = new LamportClock(1);
      const clientASeenMessages: SeenMessageMapping = {};
      const clientAMessages: Array<{
        id: EncryptedMessageId;
        timestamp: [number, number];
        payload: EncryptedBinary;
      }> = [];

      // Client A creates 10 messages
      for (let i = 1; i <= 10; i++) {
        const payload = createPayload(`Client A message ${i}`);
        const messageId = createMessageId(payload);
        const timestamp = clientA.send();

        if (!clientASeenMessages[1]) {
          clientASeenMessages[1] = {};
        }
        clientASeenMessages[1][timestamp[1]] = messageId;
        clientAMessages.push({ id: messageId, timestamp, payload });
      }

      // Verify Client A's state
      expect(Object.keys(clientASeenMessages[1]).length).toBe(10);
      expect(clientA.getTimestamp()).toEqual([1, 10]);

      // Simulate Client B (clientId: 2) creating 5 messages
      const clientB = new LamportClock(2);
      const clientBSeenMessages: SeenMessageMapping = {};
      const clientBMessages: Array<{
        id: EncryptedMessageId;
        timestamp: [number, number];
        payload: EncryptedBinary;
      }> = [];

      for (let i = 1; i <= 5; i++) {
        const payload = createPayload(`Client B message ${i}`);
        const messageId = createMessageId(payload);
        const timestamp = clientB.send();

        if (!clientBSeenMessages[2]) {
          clientBSeenMessages[2] = {};
        }
        clientBSeenMessages[2][timestamp[1]] = messageId;
        clientBMessages.push({ id: messageId, timestamp, payload });
      }

      // Client B syncs with Client A (Client B has seen nothing from A)
      const clientAStateVector = getEncryptedStateVector(clientASeenMessages);
      const clientBStateVector = getEncryptedStateVector(clientBSeenMessages);

      // Create message storage for Client A
      const clientAMessageStore = new Map<
        EncryptedMessageId,
        EncryptedBinary
      >();
      for (const msg of clientAMessages) {
        clientAMessageStore.set(msg.id, msg.payload);
      }

      // Client B requests sync from Client A
      const syncStep2 = await getDecodedSyncStep2(
        clientASeenMessages,
        async (messageId) => clientAMessageStore.get(messageId) ?? null,
        { clocks: new Map() }, // Client B has seen nothing
      );

      // Client B should receive all 10 messages from Client A
      expect(syncStep2.messages.length).toBe(10);
      expect(syncStep2.messages.map((m) => m.timestamp[1])).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
      ]);

      // Verify message IDs match
      for (const msg of syncStep2.messages) {
        const expectedMessage = clientAMessages.find(
          (m) => m.timestamp[1] === msg.timestamp[1],
        );
        expect(msg.id).toBe(expectedMessage!.id);
        expect(msg.payload).toEqual(expectedMessage!.payload);
      }

      // Now Client B merges these messages
      for (const msg of syncStep2.messages) {
        const [clientId, counter] = msg.timestamp;
        if (!clientBSeenMessages[clientId]) {
          clientBSeenMessages[clientId] = {};
        }
        clientBSeenMessages[clientId][counter] = msg.id;
        clientB.receive(msg.timestamp);
      }

      // Client B should now have seen all of Client A's messages
      expect(Object.keys(clientBSeenMessages[1] || {}).length).toBe(10);
    });

    it("should handle partial synchronization with gaps", async () => {
      // Client A has messages 1-20
      const clientA = new LamportClock(1);
      const clientASeenMessages: SeenMessageMapping = {};
      const clientAMessages: Array<{
        id: EncryptedMessageId;
        timestamp: [number, number];
        payload: EncryptedBinary;
      }> = [];

      for (let i = 1; i <= 20; i++) {
        const payload = createPayload(`A-${i}`);
        const messageId = createMessageId(payload);
        const timestamp = clientA.send();
        if (!clientASeenMessages[1]) {
          clientASeenMessages[1] = {};
        }
        clientASeenMessages[1][timestamp[1]] = messageId;
        clientAMessages.push({ id: messageId, timestamp, payload });
      }

      // Client B has already seen messages 1-5 and 15-20 (gaps in between)
      const clientB = new LamportClock(2);
      const clientBSeenMessages: SeenMessageMapping = {
        1: {
          1: clientAMessages[0].id,
          2: clientAMessages[1].id,
          3: clientAMessages[2].id,
          4: clientAMessages[3].id,
          5: clientAMessages[4].id,
          15: clientAMessages[14].id,
          16: clientAMessages[15].id,
          17: clientAMessages[16].id,
          18: clientAMessages[17].id,
          19: clientAMessages[18].id,
          20: clientAMessages[19].id,
        },
      };

      // Client B requests sync - should get messages 6-14
      const clientAMessageStore = new Map<
        EncryptedMessageId,
        EncryptedBinary
      >();
      for (const msg of clientAMessages) {
        clientAMessageStore.set(msg.id, msg.payload);
      }

      // Convert to range-based for efficient computation
      const clientARangeBased = toRangeBased(clientASeenMessages);
      const clientBRangeBased = toRangeBased(clientBSeenMessages);

      // Client B has gaps, so use full set difference
      const fullDifference = computeSetDifference(
        clientARangeBased,
        clientBRangeBased,
      );

      // Should get messages 6-14
      expect(fullDifference.get(1)?.size).toBe(9);
      const neededCounters = Array.from(fullDifference.get(1)!.keys()).sort(
        (a, b) => a - b,
      );
      expect(neededCounters).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14]);

      // Verify message IDs
      for (let counter = 6; counter <= 14; counter++) {
        const messageId = fullDifference.get(1)!.get(counter);
        expect(messageId).toBe(clientAMessages[counter - 1].id);
      }
    });

    it("should synchronize three clients in a realistic collaboration scenario", async () => {
      // Scenario: Three users editing a document
      // Client 1 (Alice) starts and creates messages 1-5
      // Client 2 (Bob) joins and creates messages 1-3
      // Client 3 (Charlie) joins later
      // Then they all continue editing

      const alice = new LamportClock(1);
      const bob = new LamportClock(2);
      const charlie = new LamportClock(3);

      const aliceSeen: SeenMessageMapping = {};
      const bobSeen: SeenMessageMapping = {};
      const charlieSeen: SeenMessageMapping = {};

      const messageStore = new Map<EncryptedMessageId, EncryptedBinary>();

      // Phase 1: Alice creates 5 messages
      const aliceMessages: Array<{
        id: EncryptedMessageId;
        timestamp: [number, number];
        payload: EncryptedBinary;
      }> = [];

      for (let i = 1; i <= 5; i++) {
        const payload = createPayload(`Alice: edit ${i}`);
        const messageId = createMessageId(payload);
        const timestamp = alice.send();
        if (!aliceSeen[1]) aliceSeen[1] = {};
        aliceSeen[1][timestamp[1]] = messageId;
        aliceMessages.push({ id: messageId, timestamp, payload });
        messageStore.set(messageId, payload);
      }

      expect(alice.getTimestamp()).toEqual([1, 5]);

      // Phase 2: Bob joins and syncs with Alice, then creates 3 messages
      const bobSyncFromAlice = await getDecodedSyncStep2(
        aliceSeen,
        async (id) => messageStore.get(id) ?? null,
        { clocks: new Map() },
      );

      // Bob receives Alice's messages
      for (const msg of bobSyncFromAlice.messages) {
        const [clientId, counter] = msg.timestamp;
        if (!bobSeen[clientId]) bobSeen[clientId] = {};
        bobSeen[clientId][counter] = msg.id;
        bob.receive(msg.timestamp);
      }

      // Bob creates 3 messages
      const bobMessages: Array<{
        id: EncryptedMessageId;
        timestamp: [number, number];
        payload: EncryptedBinary;
      }> = [];

      for (let i = 1; i <= 3; i++) {
        const payload = createPayload(`Bob: edit ${i}`);
        const messageId = createMessageId(payload);
        const timestamp = bob.send();
        if (!bobSeen[2]) bobSeen[2] = {};
        bobSeen[2][timestamp[1]] = messageId;
        bobMessages.push({ id: messageId, timestamp, payload });
        messageStore.set(messageId, payload);
      }

      // Bob's clock advanced from receiving Alice's messages (max counter 5) + 1 = 6, then sent 3 messages = 9
      // But we verify he has 3 messages from client 2
      expect(Object.keys(bobSeen[2] || {}).length).toBe(3);
      expect(bob.getTimestamp()[0]).toBe(2);

      // Phase 3: Alice syncs with Bob
      // Alice's state vector shows: client 1 at counter 5, no client 2
      // Bob's seen messages show: client 1 at counters 1-5, client 2 at counters 1-3
      // So Alice should get Bob's client 2 messages (counters 1-3)
      const aliceStateVector = getEncryptedStateVector(aliceSeen);
      const aliceDecodedStateVector = decodeFromStateVector(aliceStateVector);

      const aliceSyncFromBob = await getDecodedSyncStep2(
        bobSeen,
        async (id) => messageStore.get(id) ?? null,
        aliceDecodedStateVector, // What Alice has seen
      );

      // Alice should receive Bob's 3 messages from client 2
      expect(aliceSyncFromBob.messages.length).toBe(3);
      expect(aliceSyncFromBob.messages.every((m) => m.timestamp[0] === 2)).toBe(
        true,
      );
      for (const msg of aliceSyncFromBob.messages) {
        const [clientId, counter] = msg.timestamp;
        if (!aliceSeen[clientId]) aliceSeen[clientId] = {};
        aliceSeen[clientId][counter] = msg.id;
        alice.receive(msg.timestamp);
      }

      // Phase 4: Charlie joins and syncs with both Alice and Bob
      // Charlie should get all messages from both
      // Merge both Alice and Bob's seen messages for Charlie to sync from
      const allSeenMessages: SeenMessageMapping = {
        ...aliceSeen,
        ...bobSeen,
      };

      const charlieSync = await getDecodedSyncStep2(
        allSeenMessages,
        async (id) => messageStore.get(id) ?? null,
        { clocks: new Map() },
      );

      // Charlie should receive all 8 messages (5 from Alice, 3 from Bob)
      expect(charlieSync.messages.length).toBe(8);

      // Verify message distribution
      const aliceMessagesReceived = charlieSync.messages.filter(
        (m) => m.timestamp[0] === 1,
      );
      const bobMessagesReceived = charlieSync.messages.filter(
        (m) => m.timestamp[0] === 2,
      );

      expect(aliceMessagesReceived.length).toBe(5);
      expect(bobMessagesReceived.length).toBe(3);

      // Verify all message IDs are correct
      const receivedIds = new Set(charlieSync.messages.map((m) => m.id));
      for (const msg of [...aliceMessages, ...bobMessages]) {
        expect(receivedIds.has(msg.id)).toBe(true);
      }
    });

    it("should handle rapid consecutive message creation efficiently", async () => {
      // Simulate a client creating 100 consecutive messages rapidly
      const client = new LamportClock(1);
      const seenMessages: SeenMessageMapping = {};
      const messages: Array<{
        id: EncryptedMessageId;
        timestamp: [number, number];
        payload: EncryptedBinary;
      }> = [];

      // Create 100 consecutive messages
      for (let i = 1; i <= 100; i++) {
        const payload = createPayload(`Rapid message ${i}`);
        const messageId = createMessageId(payload);
        const timestamp = client.send();
        if (!seenMessages[1]) seenMessages[1] = {};
        seenMessages[1][timestamp[1]] = messageId;
        messages.push({ id: messageId, timestamp, payload });
      }

      // Convert to range-based - should be a single range
      const rangeBased = toRangeBased(seenMessages);
      expect(rangeBased[1].ranges.length).toBe(1);
      expect(rangeBased[1].ranges[0]).toEqual({ start: 1, end: 100 });

      // Another client syncs, having seen up to message 50
      const messageStore = new Map<EncryptedMessageId, EncryptedBinary>();
      for (const msg of messages) {
        messageStore.set(msg.id, msg.payload);
      }

      const syncResult = await getDecodedSyncStep2(
        seenMessages,
        async (id) => messageStore.get(id) ?? null,
        { clocks: new Map([[1, 50]]) },
      );

      // Should receive messages 51-100
      expect(syncResult.messages.length).toBe(50);
      expect(syncResult.messages[0].timestamp[1]).toBe(51);
      expect(syncResult.messages[49].timestamp[1]).toBe(100);

      // Verify all message IDs
      for (let i = 0; i < 50; i++) {
        const expectedCounter = 51 + i;
        const receivedMessage = syncResult.messages[i];
        expect(receivedMessage.timestamp[1]).toBe(expectedCounter);
        expect(receivedMessage.id).toBe(messages[expectedCounter - 1].id);
      }
    });

    it("should handle merging messages from multiple sources correctly", async () => {
      // Client A has messages 1-10 from client 1
      const clientASeen: SeenMessageMapping = {
        1: {},
      };
      const clientAMessages: Array<{
        id: EncryptedMessageId;
        counter: number;
        payload: EncryptedBinary;
      }> = [];

      for (let i = 1; i <= 10; i++) {
        const payload = createPayload(`A-${i}`);
        const messageId = createMessageId(payload);
        clientASeen[1][i] = messageId;
        clientAMessages.push({ id: messageId, counter: i, payload });
      }

      // Client B has messages 1-5 from client 1 and 1-3 from client 2
      const clientBSeen: SeenMessageMapping = {
        1: {},
        2: {},
      };
      const clientBMessages: Array<{
        id: EncryptedMessageId;
        clientId: number;
        counter: number;
        payload: EncryptedBinary;
      }> = [];

      for (let i = 1; i <= 5; i++) {
        const payload = createPayload(`B-client1-${i}`);
        const messageId = createMessageId(payload);
        clientBSeen[1][i] = messageId;
        clientBMessages.push({
          id: messageId,
          clientId: 1,
          counter: i,
          payload,
        });
      }

      for (let i = 1; i <= 3; i++) {
        const payload = createPayload(`B-client2-${i}`);
        const messageId = createMessageId(payload);
        clientBSeen[2][i] = messageId;
        clientBMessages.push({
          id: messageId,
          clientId: 2,
          counter: i,
          payload,
        });
      }

      // Client B syncs with Client A - should get client 1's messages 6-10
      const clientBRangeBased = toRangeBased(clientBSeen);
      const clientARangeBased = toRangeBased(clientASeen);

      // Compute what B needs from A (what A has that B doesn't)
      const difference = computeSetDifference(
        clientARangeBased,
        clientBRangeBased,
      );

      // Client B should need messages 6-10 from client 1 (which B doesn't have)
      expect(difference.has(1)).toBe(true);
      expect(difference.get(1)?.size).toBe(5);
      const neededCounters = Array.from(difference.get(1)!.keys()).sort(
        (a, b) => a - b,
      );
      expect(neededCounters).toEqual([6, 7, 8, 9, 10]);

      // Client A should need messages from client 2 (which A doesn't have)
      const reverseDifference = computeSetDifference(
        clientBRangeBased,
        clientARangeBased,
      );
      expect(reverseDifference.has(2)).toBe(true);
      expect(reverseDifference.get(2)?.size).toBe(3);

      // Merge Client B's client 2 messages into Client A
      const merged = mergeRangeBased(clientARangeBased, reverseDifference);
      const mergedSeen = fromRangeBased(merged);

      // Verify Client A now has all messages from client 1 (10 messages)
      expect(Object.keys(mergedSeen[1] || {}).length).toBe(10);
      // And now has messages from client 2 (3 messages from B)
      expect(Object.keys(mergedSeen[2] || {}).length).toBe(3);

      // Verify the message IDs match
      const client2Counters = Object.keys(mergedSeen[2] || {})
        .map(Number)
        .sort((a, b) => a - b);
      expect(client2Counters).toEqual([1, 2, 3]);
      for (let i = 1; i <= 3; i++) {
        const expectedMessage = clientBMessages.find(
          (m) => m.clientId === 2 && m.counter === i,
        );
        expect(mergedSeen[2][i]).toBe(expectedMessage!.id);
      }
    });

    it("should maintain correctness with non-consecutive message sequences", async () => {
      // Simulate a scenario where messages arrive out of order or with gaps
      const client = new LamportClock(1);
      const seenMessages: SeenMessageMapping = { 1: {} };

      // Create messages with specific counters (simulating out-of-order arrival)
      const messageSequence = [1, 2, 5, 6, 7, 10, 11, 15, 16, 17, 18, 20];
      const messages: Array<{
        id: EncryptedMessageId;
        counter: number;
        payload: EncryptedBinary;
      }> = [];

      for (const counter of messageSequence) {
        const payload = createPayload(`Gap message ${counter}`);
        const messageId = createMessageId(payload);
        seenMessages[1][counter] = messageId;
        messages.push({ id: messageId, counter, payload });
        // Simulate clock advancing (in real usage, this would happen via send/receive)
        // For testing, we'll just track the seen messages
      }

      // Convert to range-based - should create multiple ranges
      const rangeBased = toRangeBased(seenMessages);
      expect(rangeBased[1].ranges.length).toBeGreaterThan(1);

      // Verify ranges are correct
      const ranges = rangeBased[1].ranges;
      expect(ranges[0]).toEqual({ start: 1, end: 2 });
      expect(ranges[1]).toEqual({ start: 5, end: 7 });
      expect(ranges[2]).toEqual({ start: 10, end: 11 });
      expect(ranges[3]).toEqual({ start: 15, end: 18 });
      expect(ranges[4]).toEqual({ start: 20, end: 20 });

      // Another client syncs, having seen up to counter 8
      const messageStore = new Map<EncryptedMessageId, EncryptedBinary>();
      for (const msg of messages) {
        messageStore.set(msg.id, msg.payload);
      }

      const syncResult = await getDecodedSyncStep2(
        seenMessages,
        async (id) => messageStore.get(id) ?? null,
        { clocks: new Map([[1, 8]]) },
      );

      // Should receive messages with counters > 8: 10, 11, 15, 16, 17, 18, 20
      expect(syncResult.messages.length).toBe(7);
      const receivedCounters = syncResult.messages
        .map((m) => m.timestamp[1])
        .sort((a, b) => a - b);
      expect(receivedCounters).toEqual([10, 11, 15, 16, 17, 18, 20]);

      // Verify message IDs match
      for (const msg of syncResult.messages) {
        const expectedMessage = messages.find(
          (m) => m.counter === msg.timestamp[1],
        );
        expect(msg.id).toBe(expectedMessage!.id);
      }
    });

    it("should handle 1000 consecutive messages efficiently", async () => {
      // Test with 1000 messages to verify range-based reconciliation scales well
      const client = new LamportClock(1);
      const seenMessages: SeenMessageMapping = {};
      const messages: Array<{
        id: EncryptedMessageId;
        timestamp: [number, number];
        payload: EncryptedBinary;
        counter: number;
      }> = [];

      const messageStore = new Map<EncryptedMessageId, EncryptedBinary>();

      // Create 1000 consecutive messages
      for (let i = 1; i <= 1000; i++) {
        const payload = createPayload(`Message ${i} of 1000`);
        const messageId = createMessageId(payload);
        const timestamp = client.send();

        if (!seenMessages[1]) {
          seenMessages[1] = {};
        }
        seenMessages[1][timestamp[1]] = messageId;
        messages.push({
          id: messageId,
          timestamp,
          payload,
          counter: timestamp[1],
        });
        messageStore.set(messageId, payload);
      }

      // Verify all messages were created
      expect(Object.keys(seenMessages[1]).length).toBe(1000);
      expect(client.getTimestamp()).toEqual([1, 1000]);

      // Convert to range-based - should be a single range [1-1000]
      const rangeBased = toRangeBased(seenMessages);
      expect(rangeBased[1].ranges.length).toBe(1);
      expect(rangeBased[1].ranges[0]).toEqual({ start: 1, end: 1000 });
      expect(rangeBased[1].messageIds.size).toBe(1000);

      // Verify round-trip conversion
      const convertedBack = fromRangeBased(rangeBased);
      expect(Object.keys(convertedBack[1]).length).toBe(1000);
      for (let i = 1; i <= 1000; i++) {
        expect(convertedBack[1][i]).toBe(messages[i - 1].id);
      }

      // Test sync scenario: another client has seen up to message 500
      const syncResult = await getDecodedSyncStep2(
        seenMessages,
        async (id) => messageStore.get(id) ?? null,
        { clocks: new Map([[1, 500]]) },
      );

      // Should receive messages 501-1000
      expect(syncResult.messages.length).toBe(500);
      expect(syncResult.messages[0].timestamp[1]).toBe(501);
      expect(syncResult.messages[499].timestamp[1]).toBe(1000);

      // Verify all message IDs are correct
      for (let i = 0; i < 500; i++) {
        const expectedCounter = 501 + i;
        const receivedMessage = syncResult.messages[i];
        expect(receivedMessage.timestamp[1]).toBe(expectedCounter);
        expect(receivedMessage.id).toBe(messages[expectedCounter - 1].id);
        expect(receivedMessage.payload).toEqual(
          messages[expectedCounter - 1].payload,
        );
      }

      // Test partial sync: client has seen up to message 750
      const syncResult2 = await getDecodedSyncStep2(
        seenMessages,
        async (id) => messageStore.get(id) ?? null,
        { clocks: new Map([[1, 750]]) },
      );

      expect(syncResult2.messages.length).toBe(250);
      expect(syncResult2.messages[0].timestamp[1]).toBe(751);
      expect(syncResult2.messages[249].timestamp[1]).toBe(1000);

      // Test state vector encoding/decoding with 1000 messages
      const stateVector = getEncryptedStateVector(seenMessages);
      const decodedStateVector = decodeFromStateVector(stateVector);
      expect(decodedStateVector.clocks.get(1)).toBe(1000);

      // Test set difference computation with large range
      const client2Seen: SeenMessageMapping = {
        1: {},
      };
      // Client 2 has seen messages 1-250
      for (let i = 1; i <= 250; i++) {
        client2Seen[1][i] = messages[i - 1].id;
      }

      const client1RangeBased = toRangeBased(seenMessages);
      const client2RangeBased = toRangeBased(client2Seen);

      const difference = computeSetDifference(
        client1RangeBased,
        client2RangeBased,
      );
      expect(difference.get(1)?.size).toBe(750);
      const neededCounters = Array.from(difference.get(1)!.keys()).sort(
        (a, b) => a - b,
      );
      expect(neededCounters[0]).toBe(251);
      expect(neededCounters[749]).toBe(1000);
      expect(neededCounters.length).toBe(750);
    });

    it("should handle multiple large ranges efficiently", async () => {
      // Test with multiple clients, each having large ranges
      const client1 = new LamportClock(1);
      const client2 = new LamportClock(2);
      const client3 = new LamportClock(3);

      const seenMessages: SeenMessageMapping = {};
      const messageStore = new Map<EncryptedMessageId, EncryptedBinary>();

      // Client 1: 500 messages
      seenMessages[1] = {};
      for (let i = 1; i <= 500; i++) {
        const payload = createPayload(`Client1-Message-${i}`);
        const messageId = createMessageId(payload);
        const timestamp = client1.send();
        seenMessages[1][timestamp[1]] = messageId;
        messageStore.set(messageId, payload);
      }

      // Client 2: 300 messages
      seenMessages[2] = {};
      for (let i = 1; i <= 300; i++) {
        const payload = createPayload(`Client2-Message-${i}`);
        const messageId = createMessageId(payload);
        const timestamp = client2.send();
        seenMessages[2][timestamp[1]] = messageId;
        messageStore.set(messageId, payload);
      }

      // Client 3: 200 messages
      seenMessages[3] = {};
      for (let i = 1; i <= 200; i++) {
        const payload = createPayload(`Client3-Message-${i}`);
        const messageId = createMessageId(payload);
        const timestamp = client3.send();
        seenMessages[3][timestamp[1]] = messageId;
        messageStore.set(messageId, payload);
      }

      // Convert to range-based
      const rangeBased = toRangeBased(seenMessages);
      expect(rangeBased[1].ranges.length).toBe(1);
      expect(rangeBased[1].ranges[0]).toEqual({ start: 1, end: 500 });
      expect(rangeBased[2].ranges.length).toBe(1);
      expect(rangeBased[2].ranges[0]).toEqual({ start: 1, end: 300 });
      expect(rangeBased[3].ranges.length).toBe(1);
      expect(rangeBased[3].ranges[0]).toEqual({ start: 1, end: 200 });

      // Total: 1000 messages across 3 clients
      const totalMessages =
        rangeBased[1].messageIds.size +
        rangeBased[2].messageIds.size +
        rangeBased[3].messageIds.size;
      expect(totalMessages).toBe(1000);

      // Test sync: new client syncs with all three
      const syncResult = await getDecodedSyncStep2(
        seenMessages,
        async (id) => messageStore.get(id) ?? null,
        { clocks: new Map() },
      );

      expect(syncResult.messages.length).toBe(1000);

      // Verify distribution
      const client1Messages = syncResult.messages.filter(
        (m) => m.timestamp[0] === 1,
      );
      const client2Messages = syncResult.messages.filter(
        (m) => m.timestamp[0] === 2,
      );
      const client3Messages = syncResult.messages.filter(
        (m) => m.timestamp[0] === 3,
      );

      expect(client1Messages.length).toBe(500);
      expect(client2Messages.length).toBe(300);
      expect(client3Messages.length).toBe(200);

      // Verify all message IDs are unique
      const allIds = new Set(syncResult.messages.map((m) => m.id));
      expect(allIds.size).toBe(1000);
    });

    it("should handle thousands of clients efficiently", async () => {
      // Test with 5000 clients, each with multiple messages
      // This tests the system's ability to handle many different client IDs
      const NUM_CLIENTS = 5000;
      const MESSAGES_PER_CLIENT = 10;
      const TOTAL_MESSAGES = NUM_CLIENTS * MESSAGES_PER_CLIENT;

      const seenMessages: SeenMessageMapping = {};
      const messageStore = new Map<EncryptedMessageId, EncryptedBinary>();
      const clientClocks = new Map<number, LamportClock>();

      // Create messages for each client
      for (let clientId = 1; clientId <= NUM_CLIENTS; clientId++) {
        const clock = new LamportClock(clientId);
        clientClocks.set(clientId, clock);
        seenMessages[clientId] = {};

        // Each client creates 10 consecutive messages
        for (let msgNum = 1; msgNum <= MESSAGES_PER_CLIENT; msgNum++) {
          const payload = createPayload(`Client-${clientId}-Message-${msgNum}`);
          const messageId = createMessageId(payload);
          const timestamp = clock.send();
          seenMessages[clientId][timestamp[1]] = messageId;
          messageStore.set(messageId, payload);
        }
      }

      // Verify all messages were created
      expect(Object.keys(seenMessages).length).toBe(NUM_CLIENTS);
      let totalMessageCount = 0;
      for (const clientId of Object.keys(seenMessages)) {
        totalMessageCount += Object.keys(
          seenMessages[parseInt(clientId)],
        ).length;
      }
      expect(totalMessageCount).toBe(TOTAL_MESSAGES);

      // Convert to range-based format
      const rangeBased = toRangeBased(seenMessages);
      expect(Object.keys(rangeBased).length).toBe(NUM_CLIENTS);

      // Each client should have a single range [1-10]
      for (let clientId = 1; clientId <= NUM_CLIENTS; clientId++) {
        expect(rangeBased[clientId].ranges.length).toBe(1);
        expect(rangeBased[clientId].ranges[0]).toEqual({ start: 1, end: 10 });
        expect(rangeBased[clientId].messageIds.size).toBe(10);
      }

      // Test sync: new client syncs with all 5000 clients
      const syncResult = await getDecodedSyncStep2(
        seenMessages,
        async (id) => messageStore.get(id) ?? null,
        { clocks: new Map() }, // New client has seen nothing
      );

      // Should receive all messages from all clients
      expect(syncResult.messages.length).toBe(TOTAL_MESSAGES);

      // Verify message distribution - each client should contribute 10 messages
      const messagesByClient = new Map<number, number>();
      for (const msg of syncResult.messages) {
        const clientId = msg.timestamp[0];
        messagesByClient.set(
          clientId,
          (messagesByClient.get(clientId) || 0) + 1,
        );
      }

      expect(messagesByClient.size).toBe(NUM_CLIENTS);
      for (let clientId = 1; clientId <= NUM_CLIENTS; clientId++) {
        expect(messagesByClient.get(clientId)).toBe(MESSAGES_PER_CLIENT);
      }

      // Verify all message IDs are unique
      const allIds = new Set(syncResult.messages.map((m) => m.id));
      expect(allIds.size).toBe(TOTAL_MESSAGES);

      // Test partial sync: client has seen up to message 5 from each of the first 1000 clients
      const partialStateVector = new Map<number, number>();
      for (let clientId = 1; clientId <= 1000; clientId++) {
        partialStateVector.set(clientId, 5);
      }

      const partialSyncResult = await getDecodedSyncStep2(
        seenMessages,
        async (id) => messageStore.get(id) ?? null,
        { clocks: partialStateVector },
      );

      // Should receive:
      // - Messages 6-10 from clients 1-1000 (5 messages × 1000 clients = 5000)
      // - Messages 1-10 from clients 1001-5000 (10 messages × 4000 clients = 40000)
      // Total: 45000 messages
      const expectedPartialCount = 5 * 1000 + 10 * 4000;
      expect(partialSyncResult.messages.length).toBe(expectedPartialCount);

      // Verify the partial sync messages are correct
      const partialByClient = new Map<number, number[]>();
      for (const msg of partialSyncResult.messages) {
        const clientId = msg.timestamp[0];
        const counter = msg.timestamp[1];
        if (!partialByClient.has(clientId)) {
          partialByClient.set(clientId, []);
        }
        partialByClient.get(clientId)!.push(counter);
      }

      // First 1000 clients should have counters 6-10
      for (let clientId = 1; clientId <= 1000; clientId++) {
        const counters = partialByClient.get(clientId)!.sort((a, b) => a - b);
        expect(counters).toEqual([6, 7, 8, 9, 10]);
      }

      // Clients 1001-5000 should have counters 1-10
      for (let clientId = 1001; clientId <= NUM_CLIENTS; clientId++) {
        const counters = partialByClient.get(clientId)!.sort((a, b) => a - b);
        expect(counters).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      }

      // Test state vector encoding with thousands of clients
      const stateVector = getEncryptedStateVector(seenMessages);
      const decodedStateVector = decodeFromStateVector(stateVector);
      expect(decodedStateVector.clocks.size).toBe(NUM_CLIENTS);
      for (let clientId = 1; clientId <= NUM_CLIENTS; clientId++) {
        expect(decodedStateVector.clocks.get(clientId)).toBe(10);
      }

      // Test set difference computation with many clients
      // Create a second set where half the clients have seen all messages,
      // and half have seen nothing
      const partialSeenMessages: SeenMessageMapping = {};
      for (let clientId = 1; clientId <= NUM_CLIENTS / 2; clientId++) {
        partialSeenMessages[clientId] = { ...seenMessages[clientId] };
      }

      const fullRangeBased = toRangeBased(seenMessages);
      const partialRangeBased = toRangeBased(partialSeenMessages);

      const difference = computeSetDifference(
        fullRangeBased,
        partialRangeBased,
      );

      // Should have differences for clients 2501-5000 (the ones not in partial)
      expect(difference.size).toBe(NUM_CLIENTS / 2);
      for (
        let clientId = NUM_CLIENTS / 2 + 1;
        clientId <= NUM_CLIENTS;
        clientId++
      ) {
        expect(difference.has(clientId)).toBe(true);
        expect(difference.get(clientId)?.size).toBe(10);
      }
    });
  });
});
