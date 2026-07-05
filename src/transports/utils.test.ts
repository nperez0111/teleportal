import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { BinaryMessage, Message } from "teleportal";
import { createFanOutWriter, createSerialQueue, batch, createChannel } from "./utils";

// Helper function to create a test message
function createTestMessage(data: number[]): BinaryMessage {
  return new Uint8Array(data) as unknown as BinaryMessage;
}

// Helper function to collect messages from an async iterable source with aggressive timeout
async function collectMessages(
  source: AsyncIterable<BinaryMessage[]>,
  maxMessages = 10,
  timeout = 100,
): Promise<BinaryMessage[]> {
  const messages: BinaryMessage[] = [];

  return new Promise<BinaryMessage[]>((resolve) => {
    const timeoutId = setTimeout(() => {
      resolve(messages);
    }, timeout);

    const collectAsync = async () => {
      try {
        for await (const batch of source) {
          for (const msg of batch) {
            messages.push(msg);
            if (messages.length >= maxMessages) {
              clearTimeout(timeoutId);
              resolve(messages);
              return;
            }
          }
        }
      } catch {
        // Ignore errors during collection
      } finally {
        clearTimeout(timeoutId);
        resolve(messages);
      }
    };

    collectAsync();
  });
}

describe("FanOut Writer", () => {
  let fanOutWriter: ReturnType<typeof createFanOutWriter<BinaryMessage>>;

  beforeEach(() => {
    fanOutWriter = createFanOutWriter<BinaryMessage>();
  });

  afterEach(() => {
    try {
      fanOutWriter.close();
    } catch {
      // Ignore if already closed
    }
  });

  describe("Basic functionality", () => {
    it("should fan out messages to multiple readers", async () => {
      const reader1 = fanOutWriter.getReader();
      const reader2 = fanOutWriter.getReader();
      const reader3 = fanOutWriter.getReader();

      const messages = [
        createTestMessage([1, 2, 3]),
        createTestMessage([4, 5, 6]),
        createTestMessage([7, 8, 9]),
      ];

      // Start collecting messages from all readers
      const [received1Promise, received2Promise, received3Promise] = [
        collectMessages(reader1.source, 3, 50),
        collectMessages(reader2.source, 3, 50),
        collectMessages(reader3.source, 3, 50),
      ];

      // Write messages
      for (const message of messages) {
        fanOutWriter.send(message);
      }

      // Wait for all readers to receive messages
      const [received1, received2, received3] = await Promise.all([
        received1Promise,
        received2Promise,
        received3Promise,
      ]);

      // All readers should receive all messages
      expect(received1).toHaveLength(3);
      expect(received2).toHaveLength(3);
      expect(received3).toHaveLength(3);

      // Messages should be identical
      for (let i = 0; i < 3; i++) {
        expect(received1[i]).toEqual(messages[i]);
        expect(received2[i]).toEqual(messages[i]);
        expect(received3[i]).toEqual(messages[i]);
      }
    });

    it("should work with no readers", () => {
      const message = createTestMessage([1, 2, 3]);

      // Should not throw when writing to a fanout writer with no readers
      expect(() => fanOutWriter.send(message)).not.toThrow();
    });

    it("should handle readers added after writing starts", async () => {
      const message1 = createTestMessage([1, 2, 3]);

      // Write a message before any readers exist
      fanOutWriter.send(message1);

      // Add readers after message was written
      const reader1 = fanOutWriter.getReader();
      const reader2 = fanOutWriter.getReader();

      // Start collecting messages from new readers
      const [received1Promise, received2Promise] = [
        collectMessages(reader1.source, 1, 50),
        collectMessages(reader2.source, 1, 50),
      ];

      const message2 = createTestMessage([4, 5, 6]);
      fanOutWriter.send(message2);

      // New readers should only receive messages written after they were added
      const [received1, received2] = await Promise.all([received1Promise, received2Promise]);

      expect(received1).toHaveLength(1);
      expect(received2).toHaveLength(1);
      expect(received1[0]).toEqual(message2);
      expect(received2[0]).toEqual(message2);
    });
  });

  describe("Reader unsubscription", () => {
    it("should handle unsubscription without hanging", async () => {
      const reader = fanOutWriter.getReader();

      // Write a message
      const message = createTestMessage([1, 2, 3]);
      fanOutWriter.send(message);

      // Verify message received
      const received = await collectMessages(reader.source, 1, 50);
      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(message);

      // Unsubscribe should not throw
      expect(() => reader.unsubscribe()).not.toThrow();
    });

    it("should handle multiple unsubscriptions gracefully", async () => {
      const reader1 = fanOutWriter.getReader();
      const reader2 = fanOutWriter.getReader();

      // Unsubscribe both readers
      expect(() => reader1.unsubscribe()).not.toThrow();
      expect(() => reader2.unsubscribe()).not.toThrow();

      // Should not throw when writing after all readers unsubscribed
      const message = createTestMessage([1, 2, 3]);
      expect(() => fanOutWriter.send(message)).not.toThrow();
    });

    it("should handle unsubscribing the same reader multiple times", async () => {
      const reader = fanOutWriter.getReader();

      // Multiple unsubscriptions should not throw
      expect(() => reader.unsubscribe()).not.toThrow();
      expect(() => reader.unsubscribe()).not.toThrow();
      expect(() => reader.unsubscribe()).not.toThrow();
    });
  });

  describe("Writer closure", () => {
    it("should handle writer closure gracefully", async () => {
      const reader = fanOutWriter.getReader();

      const message = createTestMessage([1, 2, 3]);
      fanOutWriter.send(message);

      // Verify message received before closure
      const received = await collectMessages(reader.source, 1, 50);
      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(message);

      // Close the writer should not throw
      expect(() => fanOutWriter.close()).not.toThrow();
    });

    it("should silently no-op writes after closure", () => {
      fanOutWriter.close();

      const message = createTestMessage([1, 2, 3]);
      // After close, send silently no-ops (all subscribers removed)
      expect(() => fanOutWriter.send(message)).not.toThrow();
    });
  });
});

describe("Integration tests", () => {
  it("should create and use fanout independently", async () => {
    const fanOut = createFanOutWriter<BinaryMessage>();

    // Test fanout independently
    const reader = fanOut.getReader();
    const message1 = createTestMessage([1, 2, 3]);
    fanOut.send(message1);

    const received1 = await collectMessages(reader.source, 1, 50);
    expect(received1).toHaveLength(1);
    expect(received1[0]).toEqual(message1);

    // Cleanup
    reader.unsubscribe();
    fanOut.close();
  });

  it("should handle cleanup gracefully", async () => {
    const fanOut = createFanOutWriter<BinaryMessage>();

    const reader = fanOut.getReader();

    // Basic operations should not throw
    expect(() => fanOut.send(createTestMessage([1, 2, 3]))).not.toThrow();

    // Cleanup should not throw
    expect(() => reader.unsubscribe()).not.toThrow();
    expect(() => fanOut.close()).not.toThrow();
  });
});

describe("Batching Transform", () => {
  // Helper function to create test messages
  function createBatchTestMessage(data: number[]): Message {
    // Create a mock Message object for testing
    const encoded = new Uint8Array(data) as unknown as BinaryMessage;
    return {
      type: "doc" as const,
      document: "test-doc",
      payload: { type: "sync-step-1", sv: encoded as any },
      context: {},
      encrypted: false,
      get encoded() {
        return encoded;
      },
      get id() {
        return "test-id";
      },
      resetEncoded() {},
    } as Message;
  }

  describe("Basic functionality", () => {
    it("should batch messages up to maxBatchSize", async () => {
      const ch = createChannel<Message>();
      const batched = batch(ch, {
        maxSize: 3,
        maxDelayMs: 10,
      });

      const messages = [
        createBatchTestMessage([1, 2, 3]),
        createBatchTestMessage([4, 5, 6]),
        createBatchTestMessage([7, 8, 9]),
      ];

      // Start reading before writing
      const iter = batched[Symbol.asyncIterator]();
      const readPromise = iter.next();

      // Write messages
      for (const message of messages) {
        ch.send(message);
      }

      // Wait for batch to be sent
      const result = await readPromise;
      expect(result.done).toBe(false);
      expect(result.value).toHaveLength(3);
      expect(result.value).toEqual(messages);

      ch.close();
      await iter.return?.();
    });

    it("should send partial batch after maxBatchDelay", async () => {
      const ch = createChannel<Message>();
      const batched = batch(ch, {
        maxSize: 5,
        maxDelayMs: 5,
      });

      const messages = [createBatchTestMessage([1, 2, 3]), createBatchTestMessage([4, 5, 6])];

      // Start reading before writing
      const iter = batched[Symbol.asyncIterator]();
      const readPromise = iter.next();

      // Write messages
      for (const message of messages) {
        ch.send(message);
      }

      // Wait for timeout to trigger batch
      const result = await readPromise;
      expect(result.done).toBe(false);
      expect(result.value).toHaveLength(2);
      expect(result.value).toEqual(messages);

      ch.close();
      await iter.return?.();
    });

    it("should use default options when none provided", async () => {
      const ch = createChannel<Message>();
      const batched = batch(ch);

      const messages = Array.from({ length: 10 }, (_, i) => createBatchTestMessage([i]));

      // Start reading before writing
      const iter = batched[Symbol.asyncIterator]();
      const readPromise = iter.next();

      // Write exactly maxSize messages (default 10)
      for (const message of messages) {
        ch.send(message);
      }

      const result = await readPromise;
      expect(result.done).toBe(false);
      expect(result.value).toHaveLength(10);
      expect(result.value).toEqual(messages);

      ch.close();
      await iter.return?.();
    });
  });

  describe("Batch timing", () => {
    it("should send batch immediately when maxSize is reached", async () => {
      const ch = createChannel<Message>();
      const batched = batch(ch, {
        maxSize: 2,
        maxDelayMs: 50,
      });

      const messages = [createBatchTestMessage([1, 2, 3]), createBatchTestMessage([4, 5, 6])];

      const startTime = Date.now();

      // Start reading before writing
      const iter = batched[Symbol.asyncIterator]();
      const readPromise = iter.next();

      // Write messages
      for (const message of messages) {
        ch.send(message);
      }

      // Should receive batch immediately
      const result = await readPromise;
      const endTime = Date.now();

      expect(result.done).toBe(false);
      expect(result.value).toBeDefined();
      expect(result.value!).toHaveLength(2);
      expect(result.value!).toEqual(messages);
      expect(endTime - startTime).toBeLessThan(100);

      ch.close();
      await iter.return?.();
    });

    it("should respect maxDelayMs for partial batches", async () => {
      const maxDelayMs = 8;
      const ch = createChannel<Message>();
      const batched = batch(ch, {
        maxSize: 5,
        maxDelayMs,
      });

      const message = createBatchTestMessage([1, 2, 3]);
      const startTime = Date.now();

      // Start reading before writing
      const iter = batched[Symbol.asyncIterator]();
      const readPromise = iter.next();

      ch.send(message);

      // Should receive batch after delay
      const result = await readPromise;
      const endTime = Date.now();

      expect(result.done).toBe(false);
      expect(result.value).toBeDefined();
      expect(result.value!).toHaveLength(1);
      expect(result.value![0]).toEqual(message);
      expect(endTime - startTime).toBeGreaterThanOrEqual(maxDelayMs - 2);

      ch.close();
      await iter.return?.();
    });
  });

  describe("Multiple batches", () => {
    it("should send multiple batches correctly", async () => {
      const ch = createChannel<Message>();
      const batched = batch(ch, {
        maxSize: 2,
        maxDelayMs: 5,
      });

      const messages = [createBatchTestMessage([1]), createBatchTestMessage([2])];

      // Start reading before writing
      const iter = batched[Symbol.asyncIterator]();
      const readPromise = iter.next();

      // Write messages
      ch.send(messages[0]);
      ch.send(messages[1]);

      // Should get batch
      const result = await readPromise;

      expect(result.done).toBe(false);
      expect(result.value).toHaveLength(2);
      expect(result.value).toEqual(messages);

      ch.close();
      await iter.return?.();
    });

    it("should handle rapid message writes", async () => {
      const ch = createChannel<Message>();
      const batched = batch(ch, {
        maxSize: 3,
        maxDelayMs: 5,
      });

      const messages = Array.from({ length: 3 }, (_, i) => createBatchTestMessage([i]));

      // Start reading before writing
      const iter = batched[Symbol.asyncIterator]();
      const readPromise = iter.next();

      // Write messages rapidly
      for (const message of messages) {
        ch.send(message);
      }

      // Should get batch
      const result = await readPromise;

      expect(result.done).toBe(false);
      expect(result.value).toHaveLength(3);
      expect(result.value).toEqual(messages);

      ch.close();
      await iter.return?.();
    });
  });

  describe("Source closure", () => {
    it("should flush remaining messages on close", async () => {
      const ch = createChannel<Message>();
      const batched = batch(ch, {
        maxSize: 5,
        maxDelayMs: 5,
      });

      const messages = [createBatchTestMessage([1, 2, 3]), createBatchTestMessage([4, 5, 6])];

      // Write messages
      for (const message of messages) {
        ch.send(message);
      }

      // Close source immediately
      ch.close();

      // Collect all batches
      const allBatches: Message[][] = [];
      for await (const batch of batched) {
        allBatches.push(batch);
      }

      // Should have flushed all messages
      const allMessages = allBatches.flat();
      expect(allMessages).toHaveLength(2);
      expect(allMessages).toEqual(messages);
    });

    it("should handle empty queue on close", async () => {
      const ch = createChannel<Message>();
      const batched = batch(ch, {
        maxSize: 5,
        maxDelayMs: 5,
      });

      // Close without writing any messages
      ch.close();

      // Should produce no batches
      const allBatches: Message[][] = [];
      for await (const batch of batched) {
        allBatches.push(batch);
      }
      expect(allBatches).toHaveLength(0);
    });
  });

  describe("Edge cases", () => {
    it("should handle maxSize of 1", async () => {
      const ch = createChannel<Message>();
      const batched = batch(ch, {
        maxSize: 1,
        maxDelayMs: 2,
      });

      const message = createBatchTestMessage([1]);

      // Start reading before writing
      const iter = batched[Symbol.asyncIterator]();
      const readPromise = iter.next();

      // Write message
      ch.send(message);

      // Should get batch of 1 message
      const result = await readPromise;

      expect(result.done).toBe(false);
      expect(result.value).toHaveLength(1);
      expect(result.value![0]).toEqual(message);

      ch.close();
      await iter.return?.();
    });

    it("should handle very large maxSize", async () => {
      const ch = createChannel<Message>();
      const batched = batch(ch, {
        maxSize: 1000,
        maxDelayMs: 5,
      });

      const messages = Array.from({ length: 5 }, (_, i) => createBatchTestMessage([i]));

      // Start reading before writing
      const iter = batched[Symbol.asyncIterator]();
      const readPromise = iter.next();

      // Write messages
      for (const message of messages) {
        ch.send(message);
      }

      // Should get batch after delay since we didn't reach maxSize
      const result = await readPromise;
      expect(result.done).toBe(false);
      expect(result.value).toHaveLength(5);
      expect(result.value).toEqual(messages);

      ch.close();
      await iter.return?.();
    });

    it("should handle very small maxDelayMs", async () => {
      const ch = createChannel<Message>();
      const batched = batch(ch, {
        maxSize: 5,
        maxDelayMs: 1,
      });

      const message = createBatchTestMessage([1, 2, 3]);

      // Start reading before writing
      const iter = batched[Symbol.asyncIterator]();
      const readPromise = iter.next();

      ch.send(message);

      // Should get batch very quickly
      const result = await readPromise;
      expect(result.done).toBe(false);
      expect(result.value).toBeDefined();
      expect(result.value!).toHaveLength(1);
      expect(result.value![0]).toEqual(message);

      ch.close();
      await iter.return?.();
    });
  });

  describe("createSerialQueue", () => {
    it("resolves each enqueue only after the item is processed", async () => {
      const processed: number[] = [];
      const queue = createSerialQueue<number>(async (n) => {
        await new Promise((r) => setTimeout(r, 1));
        processed.push(n);
      });

      // The promise must not resolve before the sink ran.
      const p = queue.enqueue(1);
      expect(processed).toEqual([]);
      await p;
      expect(processed).toEqual([1]);
    });

    it("processes items strictly in enqueue order", async () => {
      const processed: number[] = [];
      const queue = createSerialQueue<number>(async (n) => {
        // Earlier items take longer; order must still be preserved.
        await new Promise((r) => setTimeout(r, n === 1 ? 1 : 0));
        processed.push(n);
      });

      await Promise.all([queue.enqueue(1), queue.enqueue(2), queue.enqueue(3)]);
      expect(processed).toEqual([1, 2, 3]);
    });

    it("a failing item rejects its own enqueue but does not poison the queue", async () => {
      const processed: number[] = [];
      const queue = createSerialQueue<number>(async (n) => {
        if (n === 2) throw new Error("boom");
        processed.push(n);
      });

      const r1 = queue.enqueue(1);
      const r2 = queue.enqueue(2);
      const r3 = queue.enqueue(3);

      await expect(r2).rejects.toThrow("boom");
      await Promise.all([r1, r3]);
      expect(processed).toEqual([1, 3]);
    });

    it("ignores items enqueued after close", async () => {
      const processed: number[] = [];
      const queue = createSerialQueue<number>((n) => {
        processed.push(n);
      });
      await queue.enqueue(1);
      queue.close();
      await queue.enqueue(2);
      expect(processed).toEqual([1]);
    });
  });
});
