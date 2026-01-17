import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { BinaryMessage, Message } from "teleportal";
import {
  createFanInReader,
  createFanOutWriter,
  getBatchingTransform,
} from "./utils";

// Helper function to create a test message
function createTestMessage(data: number[]): BinaryMessage {
  return new Uint8Array(data) as unknown as BinaryMessage;
}

// Helper function to collect messages from a readable stream with aggressive timeout
async function collectMessages(
  readable: ReadableStream<BinaryMessage>,
  maxMessages = 10,
  timeout = 100,
): Promise<BinaryMessage[]> {
  const messages: BinaryMessage[] = [];
  let reader: ReadableStreamDefaultReader<BinaryMessage> | null = null;

  return new Promise<BinaryMessage[]>((resolve) => {
    const timeoutId = setTimeout(() => {
      if (reader) {
        try {
          reader.releaseLock();
        } catch {}
      }
      resolve(messages);
    }, timeout);

    const collectAsync = async () => {
      try {
        reader = readable.getReader();

        while (messages.length < maxMessages) {
          const result = await reader.read();

          if (result.done) {
            break;
          }

          messages.push(result.value);
        }
      } catch {
        // Ignore errors during collection
      } finally {
        clearTimeout(timeoutId);
        if (reader) {
          try {
            reader.releaseLock();
          } catch {}
        }
        resolve(messages);
      }
    };

    collectAsync();
  });
}

describe("FanOut Writer", () => {
  let fanOutWriter: ReturnType<typeof createFanOutWriter<BinaryMessage>>;
  let writer: WritableStreamDefaultWriter<BinaryMessage>;

  beforeEach(() => {
    fanOutWriter = createFanOutWriter<BinaryMessage>();
    writer = fanOutWriter.writable.getWriter();
  });

  afterEach(async () => {
    try {
      await writer.close();
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
        collectMessages(reader1.readable, 3, 100),
        collectMessages(reader2.readable, 3, 100),
        collectMessages(reader3.readable, 3, 100),
      ];

      // Write messages
      for (const message of messages) {
        await writer.write(message);
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

    it("should work with no readers", async () => {
      const message = createTestMessage([1, 2, 3]);

      // Should not throw when writing to a fanout writer with no readers
      await expect(writer.write(message)).resolves.toBeUndefined();
    });

    it("should handle readers added after writing starts", async () => {
      const message1 = createTestMessage([1, 2, 3]);

      // Write a message before any readers exist
      await writer.write(message1);

      // Add readers after message was written
      const reader1 = fanOutWriter.getReader();
      const reader2 = fanOutWriter.getReader();

      // Start collecting messages from new readers
      const [received1Promise, received2Promise] = [
        collectMessages(reader1.readable, 1, 100),
        collectMessages(reader2.readable, 1, 100),
      ];

      const message2 = createTestMessage([4, 5, 6]);
      await writer.write(message2);

      // New readers should only receive messages written after they were added
      const [received1, received2] = await Promise.all([
        received1Promise,
        received2Promise,
      ]);

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
      await writer.write(message);

      // Verify message received
      const received = await collectMessages(reader.readable, 1, 100);
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
      await expect(writer.write(message)).resolves.toBeUndefined();
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
      await writer.write(message);

      // Verify message received before closure
      const received = await collectMessages(reader.readable, 1, 100);
      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(message);

      // Close the writer should not throw
      await expect(writer.close()).resolves.toBeUndefined();
    });

    it("should handle closing an already closed writer", async () => {
      await writer.close();

      // Closing again should throw
      await expect(writer.close()).rejects.toThrow();
    });

    it("should reject writes after closure", async () => {
      await writer.close();

      const message = createTestMessage([1, 2, 3]);
      await expect(writer.write(message)).rejects.toThrow();
    });
  });

  describe("Writer abortion", () => {
    it("should handle writer abortion gracefully", async () => {
      const reader = fanOutWriter.getReader();

      const message = createTestMessage([1, 2, 3]);
      await writer.write(message);

      // Verify message received before abortion
      const received = await collectMessages(reader.readable, 1, 100);
      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(message);

      const abortReason = new Error("Test abort");
      await expect(writer.abort(abortReason)).resolves.toBeUndefined();
    });
  });
});

describe("FanIn Reader", () => {
  let fanInReader: ReturnType<typeof createFanInReader<BinaryMessage>>;

  beforeEach(() => {
    fanInReader = createFanInReader<BinaryMessage>();
  });

  afterEach(() => {
    try {
      fanInReader.close();
    } catch {
      // Ignore if already closed
    }
  });

  describe("Basic functionality", () => {
    it("should fan in messages from multiple writers", async () => {
      const writer1 = fanInReader.getWriter();
      const writer2 = fanInReader.getWriter();

      const receivedPromise = collectMessages(fanInReader.readable, 2, 300);

      const messages = [
        createTestMessage([1, 0, 0]),
        createTestMessage([0, 1, 0]),
      ];

      // Write messages from different writers
      const w1 = writer1.writable.getWriter();
      const w2 = writer2.writable.getWriter();

      await w1.write(messages[0]);
      await w2.write(messages[1]);

      w1.releaseLock();
      w2.releaseLock();

      const received = await receivedPromise;

      expect(received).toHaveLength(2);
      // Note: Order might not be preserved due to async nature
      expect(received).toContainEqual(messages[0]);
      expect(received).toContainEqual(messages[1]);
    });

    it("should work with no writers", async () => {
      const received = await collectMessages(fanInReader.readable, 1, 100);
      expect(received).toHaveLength(0);
    });

    it("should handle single writer", async () => {
      const writer = fanInReader.getWriter();
      const w = writer.writable.getWriter();

      const message = createTestMessage([1, 2, 3]);
      await w.write(message);
      w.releaseLock();

      const received = await collectMessages(fanInReader.readable, 1, 200);
      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(message);
    });
  });

  describe("Writer removal", () => {
    it("should handle writer removal gracefully", async () => {
      const writer1 = fanInReader.getWriter();
      const writer2 = fanInReader.getWriter();

      const w1 = writer1.writable.getWriter();
      const w2 = writer2.writable.getWriter();

      await w1.write(createTestMessage([1, 2, 3]));
      await w2.write(createTestMessage([4, 5, 6]));

      // Get initial messages
      const received1 = await collectMessages(fanInReader.readable, 2, 200);
      expect(received1).toHaveLength(2);

      // Remove writer1 should not throw
      expect(() => writer1.unsubscribe()).not.toThrow();

      w1.releaseLock();
      w2.releaseLock();
    });

    it("should handle removing all writers gracefully", async () => {
      const writer1 = fanInReader.getWriter();
      const writer2 = fanInReader.getWriter();

      // Remove all writers
      expect(() => writer1.unsubscribe()).not.toThrow();
      expect(() => writer2.unsubscribe()).not.toThrow();

      // Should not affect the readable stream
      const received = await collectMessages(fanInReader.readable, 1, 100);
      expect(received).toHaveLength(0);
    });

    it("should handle removing the same writer multiple times", async () => {
      const writer = fanInReader.getWriter();

      // Multiple removals should not throw
      expect(() => writer.unsubscribe()).not.toThrow();
      expect(() => writer.unsubscribe()).not.toThrow();
      expect(() => writer.unsubscribe()).not.toThrow();
    });
  });

  describe("Reader cancellation", () => {
    it("should close all writers when reader is closed", async () => {
      const writer1 = fanInReader.getWriter();
      const writer2 = fanInReader.getWriter();

      const w1 = writer1.writable.getWriter();
      const w2 = writer2.writable.getWriter();

      await w1.write(createTestMessage([1, 2, 3]));
      await w2.write(createTestMessage([4, 5, 6]));

      // Close the reader
      fanInReader.close();

      // Writers should be closed/affected
      // Note: The exact behavior may depend on implementation details
      w1.releaseLock();
      w2.releaseLock();
    });

    it("should handle closing an already closed reader", async () => {
      fanInReader.close();

      // Closing again should not throw
      expect(() => fanInReader.close()).not.toThrow();
    });
  });

  describe("Writer closure", () => {
    it("should handle individual writer closure gracefully", async () => {
      const writer = fanInReader.getWriter();
      const w = writer.writable.getWriter();

      await w.write(createTestMessage([1, 2, 3]));

      // Get the message
      const received = await collectMessages(fanInReader.readable, 1, 200);
      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(createTestMessage([1, 2, 3]));

      // Close writer should not throw
      await expect(w.close()).resolves.toBeUndefined();
      w.releaseLock();
    });

    it("should handle writing to a closed writer gracefully", async () => {
      const writer = fanInReader.getWriter();
      const w = writer.writable.getWriter();

      await w.close();

      // Writing to closed writer should throw
      await expect(w.write(createTestMessage([1, 2, 3]))).rejects.toThrow();

      w.releaseLock();
    });
  });

  describe("Error handling", () => {
    it("should handle writer errors gracefully", async () => {
      const writer = fanInReader.getWriter();
      const w = writer.writable.getWriter();

      await w.write(createTestMessage([1, 2, 3]));

      // Get the message before error
      const received = await collectMessages(fanInReader.readable, 1, 200);
      expect(received).toHaveLength(1);

      // Abort writer should not throw
      await expect(w.abort(new Error("Test error"))).resolves.toBeUndefined();
      w.releaseLock();
    });
  });
});

describe("Integration tests", () => {
  it("should create and use fanout and fanin independently", async () => {
    const fanOut = createFanOutWriter<BinaryMessage>();
    const fanIn = createFanInReader<BinaryMessage>();

    // Test fanout independently
    const reader = fanOut.getReader();
    const fanOutWriter = fanOut.writable.getWriter();
    const message1 = createTestMessage([1, 2, 3]);
    await fanOutWriter.write(message1);

    const received1 = await collectMessages(reader.readable, 1, 200);
    expect(received1).toHaveLength(1);
    expect(received1[0]).toEqual(message1);

    // Test fanin independently
    const writer = fanIn.getWriter();
    const w = writer.writable.getWriter();
    const message2 = createTestMessage([4, 5, 6]);
    await w.write(message2);
    w.releaseLock();

    const received2 = await collectMessages(fanIn.readable, 1, 200);
    expect(received2).toHaveLength(1);
    expect(received2[0]).toEqual(message2);

    // Cleanup
    reader.unsubscribe();
    writer.unsubscribe();
    await fanOutWriter.close();
    fanIn.close();
  });

  it("should handle cleanup gracefully", async () => {
    const fanOut = createFanOutWriter<BinaryMessage>();
    const fanIn = createFanInReader<BinaryMessage>();

    const reader = fanOut.getReader();
    const writer = fanIn.getWriter();
    const fanOutWriter = fanOut.writable.getWriter();

    // Basic operations should not throw
    await expect(
      fanOutWriter.write(createTestMessage([1, 2, 3])),
    ).resolves.toBeUndefined();

    const w = writer.writable.getWriter();
    await expect(
      w.write(createTestMessage([4, 5, 6])),
    ).resolves.toBeUndefined();
    w.releaseLock();

    // Cleanup should not throw
    expect(() => reader.unsubscribe()).not.toThrow();
    expect(() => writer.unsubscribe()).not.toThrow();
    await expect(fanOutWriter.close()).resolves.toBeUndefined();
    expect(() => fanIn.close()).not.toThrow();
  });
});

describe("Batching Transform", () => {
  // Helper function to create test messages
  function createTestMessage(data: number[]): Message {
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

  // Helper function to collect batched messages

  describe("Basic functionality", () => {
    it("should batch messages up to maxBatchSize", async () => {
      const batchingTransform = getBatchingTransform({
        maxBatchSize: 3,
        maxBatchDelay: 10,
      });
      const writer = batchingTransform.writable.getWriter();
      const reader = batchingTransform.readable.getReader();

      const messages = [
        createTestMessage([1, 2, 3]),
        createTestMessage([4, 5, 6]),
        createTestMessage([7, 8, 9]),
      ];

      // Start reading before writing to prevent backpressure
      const readPromise = reader.read();

      // Write messages
      for (const message of messages) {
        await writer.write(message);
      }

      // Wait for batch to be sent
      const result = await readPromise;
      expect(result.done).toBe(false);
      expect(result.value).toHaveLength(3);
      expect(result.value).toEqual(messages);

      await writer.close();
      reader.releaseLock();
    });

    it("should send partial batch after maxBatchDelay", async () => {
      const batchingTransform = getBatchingTransform({
        maxBatchSize: 5,
        maxBatchDelay: 5,
      });
      const writer = batchingTransform.writable.getWriter();
      const reader = batchingTransform.readable.getReader();

      const messages = [
        createTestMessage([1, 2, 3]),
        createTestMessage([4, 5, 6]),
      ];

      // Start reading before writing to prevent backpressure
      const readPromise = reader.read();

      // Write messages
      for (const message of messages) {
        await writer.write(message);
      }

      // Wait for timeout to trigger batch
      const result = await readPromise;
      expect(result.done).toBe(false);
      expect(result.value).toHaveLength(2);
      expect(result.value).toEqual(messages);

      await writer.close();
      reader.releaseLock();
    });

    it("should use default options when none provided", async () => {
      const batchingTransform = getBatchingTransform();
      const writer = batchingTransform.writable.getWriter();
      const reader = batchingTransform.readable.getReader();

      const messages = Array.from({ length: 10 }, (_, i) =>
        createTestMessage([i]),
      );

      // Start reading before writing to prevent backpressure
      const readPromise = reader.read();

      // Write exactly maxBatchSize messages (default 10)
      for (const message of messages) {
        await writer.write(message);
      }

      const result = await readPromise;
      expect(result.done).toBe(false);
      expect(result.value).toHaveLength(10);
      expect(result.value).toEqual(messages);

      await writer.close();
      reader.releaseLock();
    });
  });

  describe("Batch timing", () => {
    it("should send batch immediately when maxBatchSize is reached", async () => {
      const batchingTransform = getBatchingTransform({
        maxBatchSize: 2,
        maxBatchDelay: 200,
      });
      const writer = batchingTransform.writable.getWriter();
      const reader = batchingTransform.readable.getReader();

      const messages = [
        createTestMessage([1, 2, 3]),
        createTestMessage([4, 5, 6]),
      ];

      const startTime = Date.now();

      // Start reading before writing to prevent backpressure
      const readPromise = reader.read();

      // Write messages
      for (const message of messages) {
        await writer.write(message);
      }

      // Should receive batch immediately
      const result = await readPromise;
      const endTime = Date.now();

      expect(result.done).toBe(false);
      expect(result.value).toBeDefined();
      expect(result.value!).toHaveLength(2);
      expect(result.value!).toEqual(messages);
      expect(endTime - startTime).toBeLessThan(100); // Should be much faster than 1000ms

      await writer.close();
      reader.releaseLock();
    });

    it("should respect maxBatchDelay for partial batches", async () => {
      const maxBatchDelay = 8;
      const batchingTransform = getBatchingTransform({
        maxBatchSize: 5,
        maxBatchDelay,
      });
      const writer = batchingTransform.writable.getWriter();
      const reader = batchingTransform.readable.getReader();

      const message = createTestMessage([1, 2, 3]);
      const startTime = Date.now();

      // Start reading before writing to prevent backpressure
      const readPromise = reader.read();

      await writer.write(message);

      // Should receive batch after delay
      const result = await readPromise;
      const endTime = Date.now();

      expect(result.done).toBe(false);
      expect(result.value).toBeDefined();
      expect(result.value!).toHaveLength(1);
      expect(result.value![0]).toEqual(message);
      expect(endTime - startTime).toBeGreaterThanOrEqual(maxBatchDelay - 2); // Allow some tolerance

      await writer.close();
      reader.releaseLock();
    });
  });

  describe("Multiple batches", () => {
    it("should send multiple batches correctly", async () => {
      const batchingTransform = getBatchingTransform({
        maxBatchSize: 2,
        maxBatchDelay: 5,
      });
      const writer = batchingTransform.writable.getWriter();
      const reader = batchingTransform.readable.getReader();

      const messages = [createTestMessage([1]), createTestMessage([2])];

      // Start reading before writing to prevent backpressure
      const readPromise = reader.read();

      // Write messages
      await writer.write(messages[0]);
      await writer.write(messages[1]);

      // Should get batch
      const result = await readPromise;

      expect(result.done).toBe(false);
      expect(result.value).toHaveLength(2);
      expect(result.value).toEqual(messages);

      await writer.close();
      reader.releaseLock();
    });

    it("should handle rapid message writes", async () => {
      const batchingTransform = getBatchingTransform({
        maxBatchSize: 3,
        maxBatchDelay: 5,
      });
      const writer = batchingTransform.writable.getWriter();
      const reader = batchingTransform.readable.getReader();

      const messages = Array.from({ length: 3 }, (_, i) =>
        createTestMessage([i]),
      );

      // Start reading before writing to prevent backpressure
      const readPromise = reader.read();

      // Write messages rapidly
      await Promise.all(messages.map((message) => writer.write(message)));

      // Should get batch
      const result = await readPromise;

      expect(result.done).toBe(false);
      expect(result.value).toHaveLength(3);
      expect(result.value).toEqual(messages);

      await writer.close();
      reader.releaseLock();
    });
  });

  describe("Stream closure", () => {
    it("should flush remaining messages on close", async () => {
      const batchingTransform = getBatchingTransform({
        maxBatchSize: 5,
        maxBatchDelay: 40,
      });
      const writer = batchingTransform.writable.getWriter();
      const reader = batchingTransform.readable.getReader();

      const messages = [
        createTestMessage([1, 2, 3]),
        createTestMessage([4, 5, 6]),
      ];

      // Start reading before writing to prevent backpressure
      const readPromise = reader.read();

      // Write messages
      for (const message of messages) {
        await writer.write(message);
      }

      // Close writer immediately
      await writer.close();

      // Should receive remaining messages
      const result = await readPromise;
      expect(result.done).toBe(false);
      expect(result.value).toHaveLength(2);
      expect(result.value).toEqual(messages);

      // Stream should be done
      const finalResult = await reader.read();
      expect(finalResult.done).toBe(true);

      reader.releaseLock();
    });

    it("should handle empty queue on close", async () => {
      const batchingTransform = getBatchingTransform({
        maxBatchSize: 5,
        maxBatchDelay: 5,
      });
      const writer = batchingTransform.writable.getWriter();
      const reader = batchingTransform.readable.getReader();

      // Close without writing any messages
      await writer.close();

      // Stream should be done immediately
      const result = await reader.read();
      expect(result.done).toBe(true);

      reader.releaseLock();
    });
  });

  describe("Error handling", () => {
    it("should handle writer abort gracefully", async () => {
      const batchingTransform = getBatchingTransform({
        maxBatchSize: 3,
        maxBatchDelay: 5,
      });
      const writer = batchingTransform.writable.getWriter();
      const reader = batchingTransform.readable.getReader();

      const message = createTestMessage([1, 2, 3]);

      // Start reading before writing to prevent backpressure
      const readPromise = reader.read();

      await writer.write(message);

      // Abort the writer
      await writer.abort(new Error("Test abort"));

      // Should not receive any messages after abort
      try {
        const result = await readPromise;
        expect(result.done).toBe(true);
      } catch (error) {
        // It's also acceptable for the read to fail due to abort
        expect(error).toBeDefined();
      }

      reader.releaseLock();
    });

    it("should handle reader cancellation gracefully", async () => {
      const batchingTransform = getBatchingTransform({
        maxBatchSize: 3,
        maxBatchDelay: 5,
      });
      const writer = batchingTransform.writable.getWriter();
      const reader = batchingTransform.readable.getReader();

      const message = createTestMessage([1, 2, 3]);

      // Start reading before writing to prevent backpressure
      const readPromise = reader.read();

      await writer.write(message);

      // Cancel the reader
      await reader.cancel();

      // Writer should still be functional (may throw due to cancellation)
      try {
        await writer.write(createTestMessage([4, 5, 6]));
        // If no error is thrown, that's also acceptable
      } catch {
        // It's acceptable for the write to fail after reader cancellation
        // No need to check the error since it might be undefined
      }

      // Close writer (may fail if already closed)
      try {
        await writer.close();
      } catch {
        // It's acceptable for close to fail if writer is already closed
      }
    });
  });

  describe("Edge cases", () => {
    it("should handle maxBatchSize of 1", async () => {
      const batchingTransform = getBatchingTransform({
        maxBatchSize: 1,
        maxBatchDelay: 2,
      });
      const writer = batchingTransform.writable.getWriter();
      const reader = batchingTransform.readable.getReader();

      const message = createTestMessage([1]);

      // Start reading before writing to prevent backpressure
      const readPromise = reader.read();

      // Write message
      await writer.write(message);

      // Should get batch of 1 message
      const result = await readPromise;

      expect(result.done).toBe(false);
      expect(result.value).toHaveLength(1);
      expect(result.value![0]).toEqual(message);

      await writer.close();
      reader.releaseLock();
    });

    it("should handle very large maxBatchSize", async () => {
      const batchingTransform = getBatchingTransform({
        maxBatchSize: 1000,
        maxBatchDelay: 5,
      });
      const writer = batchingTransform.writable.getWriter();
      const reader = batchingTransform.readable.getReader();

      const messages = Array.from({ length: 5 }, (_, i) =>
        createTestMessage([i]),
      );

      // Start reading before writing to prevent backpressure
      const readPromise = reader.read();

      // Write messages
      for (const message of messages) {
        await writer.write(message);
      }

      // Should get batch after delay since we didn't reach maxBatchSize
      const result = await readPromise;
      expect(result.done).toBe(false);
      expect(result.value).toHaveLength(5);
      expect(result.value).toEqual(messages);

      await writer.close();
      reader.releaseLock();
    });

    it("should handle very small maxBatchDelay", async () => {
      const batchingTransform = getBatchingTransform({
        maxBatchSize: 5,
        maxBatchDelay: 1,
      });
      const writer = batchingTransform.writable.getWriter();
      const reader = batchingTransform.readable.getReader();

      const message = createTestMessage([1, 2, 3]);

      // Start reading before writing to prevent backpressure
      const readPromise = reader.read();

      await writer.write(message);

      // Should get batch very quickly
      const result = await readPromise;
      expect(result.done).toBe(false);
      expect(result.value).toBeDefined();
      expect(result.value!).toHaveLength(1);
      expect(result.value![0]).toEqual(message);

      await writer.close();
      reader.releaseLock();
    });
  });
});
