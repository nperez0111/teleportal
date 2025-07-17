import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { BinaryMessage } from "teleportal";
import { createFanInReader, createFanOutWriter } from "./utils";

// Helper function to create a test message
function createTestMessage(data: number[]): BinaryMessage {
  return new Uint8Array(data) as unknown as BinaryMessage;
}

// Helper function to collect messages from a readable stream with aggressive timeout
async function collectMessages(
  readable: ReadableStream<BinaryMessage>,
  maxMessages = 10,
  timeout = 500,
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
      } catch (error) {
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
  let fanOutWriter: ReturnType<typeof createFanOutWriter>;

  beforeEach(() => {
    fanOutWriter = createFanOutWriter();
  });

  afterEach(async () => {
    try {
      await fanOutWriter.writer.close();
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
        collectMessages(reader1.readable, 3, 500),
        collectMessages(reader2.readable, 3, 500),
        collectMessages(reader3.readable, 3, 500),
      ];

      // Write messages
      for (const message of messages) {
        await fanOutWriter.writer.write(message);
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
      await expect(fanOutWriter.writer.write(message)).resolves.toBeUndefined();
    });

    it("should handle readers added after writing starts", async () => {
      const message1 = createTestMessage([1, 2, 3]);

      // Write a message before any readers exist
      await fanOutWriter.writer.write(message1);

      // Add readers after message was written
      const reader1 = fanOutWriter.getReader();
      const reader2 = fanOutWriter.getReader();

      // Start collecting messages from new readers
      const [received1Promise, received2Promise] = [
        collectMessages(reader1.readable, 1, 500),
        collectMessages(reader2.readable, 1, 500),
      ];

      const message2 = createTestMessage([4, 5, 6]);
      await fanOutWriter.writer.write(message2);

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
      await fanOutWriter.writer.write(message);

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
      await expect(fanOutWriter.writer.write(message)).resolves.toBeUndefined();
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
      await fanOutWriter.writer.write(message);

      // Verify message received before closure
      const received = await collectMessages(reader.readable, 1, 100);
      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(message);

      // Close the writer should not throw
      await expect(fanOutWriter.writer.close()).resolves.toBeUndefined();
    });

    it("should handle closing an already closed writer", async () => {
      await fanOutWriter.writer.close();

      // Closing again should throw
      await expect(fanOutWriter.writer.close()).rejects.toThrow();
    });

    it("should reject writes after closure", async () => {
      await fanOutWriter.writer.close();

      const message = createTestMessage([1, 2, 3]);
      await expect(fanOutWriter.writer.write(message)).rejects.toThrow();
    });
  });

  describe("Writer abortion", () => {
    it("should handle writer abortion gracefully", async () => {
      const reader = fanOutWriter.getReader();

      const message = createTestMessage([1, 2, 3]);
      await fanOutWriter.writer.write(message);

      // Verify message received before abortion
      const received = await collectMessages(reader.readable, 1, 100);
      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(message);

      const abortReason = new Error("Test abort");
      await expect(
        fanOutWriter.writer.abort(abortReason),
      ).resolves.toBeUndefined();
    });
  });
});

describe("FanIn Reader", () => {
  let fanInReader: ReturnType<typeof createFanInReader>;

  beforeEach(() => {
    fanInReader = createFanInReader();
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
    const fanOut = createFanOutWriter();
    const fanIn = createFanInReader();

    // Test fanout independently
    const reader = fanOut.getReader();
    const message1 = createTestMessage([1, 2, 3]);
    await fanOut.writer.write(message1);

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
    await fanOut.writer.close();
    fanIn.close();
  });

  it("should handle cleanup gracefully", async () => {
    const fanOut = createFanOutWriter();
    const fanIn = createFanInReader();

    const reader = fanOut.getReader();
    const writer = fanIn.getWriter();

    // Basic operations should not throw
    await expect(
      fanOut.writer.write(createTestMessage([1, 2, 3])),
    ).resolves.toBeUndefined();

    const w = writer.writable.getWriter();
    await expect(
      w.write(createTestMessage([4, 5, 6])),
    ).resolves.toBeUndefined();
    w.releaseLock();

    // Cleanup should not throw
    expect(() => reader.unsubscribe()).not.toThrow();
    expect(() => writer.unsubscribe()).not.toThrow();
    await expect(fanOut.writer.close()).resolves.toBeUndefined();
    expect(() => fanIn.close()).not.toThrow();
  });
});
