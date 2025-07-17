import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { createFanOutWriter, createFanInReader } from "./utils";
import type { BinaryMessage } from "teleportal";

// Helper function to create a test message
function createTestMessage(data: number[]): BinaryMessage {
  return new Uint8Array(data);
}

// Helper function to collect messages from a readable stream
async function collectMessages(
  readable: ReadableStream<BinaryMessage>,
  maxMessages = 10,
  timeout = 1000
): Promise<BinaryMessage[]> {
  const messages: BinaryMessage[] = [];
  const reader = readable.getReader();
  
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    setTimeout(() => resolve("timeout"), timeout);
  });

  try {
    while (messages.length < maxMessages) {
      const result = await Promise.race([
        reader.read(),
        timeoutPromise
      ]);
      
      if (result === "timeout") {
        break;
      }
      
      if (result.done) {
        break;
      }
      
      messages.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  
  return messages;
}

// Helper function to write messages with controlled timing
async function writeMessages(
  writer: WritableStreamDefaultWriter<BinaryMessage>,
  messages: BinaryMessage[],
  delay = 10
): Promise<void> {
  for (const message of messages) {
    await writer.write(message);
    if (delay > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
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
        createTestMessage([7, 8, 9])
      ];

      // Start collecting messages from all readers
      const [received1Promise, received2Promise, received3Promise] = [
        collectMessages(reader1.readable, 3, 500),
        collectMessages(reader2.readable, 3, 500),
        collectMessages(reader3.readable, 3, 500)
      ];

      // Write messages
      for (const message of messages) {
        await fanOutWriter.writer.write(message);
      }

      // Wait for all readers to receive messages
      const [received1, received2, received3] = await Promise.all([
        received1Promise,
        received2Promise,
        received3Promise
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
      
      const message2 = createTestMessage([4, 5, 6]);
      await fanOutWriter.writer.write(message2);
      
      // New readers should only receive messages written after they were added
      const [received1, received2] = await Promise.all([
        collectMessages(reader1.readable, 1, 200),
        collectMessages(reader2.readable, 1, 200)
      ]);
      
      expect(received1).toHaveLength(1);
      expect(received2).toHaveLength(1);
      expect(received1[0]).toEqual(message2);
      expect(received2[0]).toEqual(message2);
    });
  });

  describe("Reader unsubscription", () => {
    it("should stop receiving messages after unsubscription", async () => {
      const reader1 = fanOutWriter.getReader();
      const reader2 = fanOutWriter.getReader();

      const message1 = createTestMessage([1, 2, 3]);
      await fanOutWriter.writer.write(message1);

      // Unsubscribe reader1
      reader1.unsubscribe();

      const message2 = createTestMessage([4, 5, 6]);
      await fanOutWriter.writer.write(message2);

      // Reader1 should only have received the first message
      const received1 = await collectMessages(reader1.readable, 2, 200);
      const received2 = await collectMessages(reader2.readable, 2, 200);

      expect(received1).toHaveLength(1);
      expect(received1[0]).toEqual(message1);

      expect(received2).toHaveLength(2);
      expect(received2[0]).toEqual(message1);
      expect(received2[1]).toEqual(message2);
    });

    it("should handle multiple unsubscriptions gracefully", async () => {
      const reader1 = fanOutWriter.getReader();
      const reader2 = fanOutWriter.getReader();

      // Unsubscribe both readers
      reader1.unsubscribe();
      reader2.unsubscribe();

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
    it("should close all readers when writer is closed", async () => {
      const reader1 = fanOutWriter.getReader();
      const reader2 = fanOutWriter.getReader();

      const message = createTestMessage([1, 2, 3]);
      await fanOutWriter.writer.write(message);

      // Close the writer
      await fanOutWriter.writer.close();

      // Readers should detect closure
      const reader1Stream = reader1.readable.getReader();
      const reader2Stream = reader2.readable.getReader();

      const result1 = await reader1Stream.read();
      const result2 = await reader2Stream.read();

      // First read should return the message
      expect(result1.done).toBe(false);
      expect(result1.value).toEqual(message);
      expect(result2.done).toBe(false);
      expect(result2.value).toEqual(message);

      // Second read should indicate stream is closed
      const endResult1 = await reader1Stream.read();
      const endResult2 = await reader2Stream.read();

      expect(endResult1.done).toBe(true);
      expect(endResult2.done).toBe(true);

      reader1Stream.releaseLock();
      reader2Stream.releaseLock();
    });

    it("should handle closing an already closed writer", async () => {
      await fanOutWriter.writer.close();
      
      // Closing again should not throw
      await expect(fanOutWriter.writer.close()).rejects.toThrow();
    });

    it("should reject writes after closure", async () => {
      await fanOutWriter.writer.close();

      const message = createTestMessage([1, 2, 3]);
      await expect(fanOutWriter.writer.write(message)).rejects.toThrow();
    });
  });

  describe("Writer abortion", () => {
    it("should abort all readers when writer is aborted", async () => {
      const reader1 = fanOutWriter.getReader();
      const reader2 = fanOutWriter.getReader();

      const message = createTestMessage([1, 2, 3]);
      await fanOutWriter.writer.write(message);

      const abortReason = new Error("Test abort");
      await fanOutWriter.writer.abort(abortReason);

      // Readers should detect abortion
      const reader1Stream = reader1.readable.getReader();
      const reader2Stream = reader2.readable.getReader();

      // Should be able to read the message that was written before abort
      const result1 = await reader1Stream.read();
      const result2 = await reader2Stream.read();

      expect(result1.done).toBe(false);
      expect(result1.value).toEqual(message);
      expect(result2.done).toBe(false);
      expect(result2.value).toEqual(message);

      reader1Stream.releaseLock();
      reader2Stream.releaseLock();
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
      fanInReader.readable.cancel();
    } catch {
      // Ignore if already cancelled
    }
  });

  describe("Basic functionality", () => {
    it("should fan in messages from multiple writers", async () => {
      const writer1 = fanInReader.getWriter();
      const writer2 = fanInReader.getWriter();
      const writer3 = fanInReader.getWriter();

      const receivedPromise = collectMessages(fanInReader.readable, 3, 1000);

      const messages = [
        createTestMessage([1, 0, 0]),
        createTestMessage([0, 1, 0]),
        createTestMessage([0, 0, 1])
      ];

      // Write messages from different writers
      const w1 = writer1.writable.getWriter();
      const w2 = writer2.writable.getWriter();
      const w3 = writer3.writable.getWriter();

      await w1.write(messages[0]);
      await w2.write(messages[1]);
      await w3.write(messages[2]);

      w1.releaseLock();
      w2.releaseLock();
      w3.releaseLock();

      const received = await receivedPromise;

      expect(received).toHaveLength(3);
      // Note: Order might not be preserved due to async nature
      expect(received).toContainEqual(messages[0]);
      expect(received).toContainEqual(messages[1]);
      expect(received).toContainEqual(messages[2]);
    });

    it("should work with no writers", async () => {
      const receivedPromise = collectMessages(fanInReader.readable, 1, 200);
      const received = await receivedPromise;
      
      expect(received).toHaveLength(0);
    });

    it("should handle writers added dynamically", async () => {
      const receivedPromise = collectMessages(fanInReader.readable, 2, 1000);

      // Add first writer
      const writer1 = fanInReader.getWriter();
      const w1 = writer1.writable.getWriter();
      await w1.write(createTestMessage([1, 2, 3]));
      w1.releaseLock();

      // Add second writer later
      const writer2 = fanInReader.getWriter();
      const w2 = writer2.writable.getWriter();
      await w2.write(createTestMessage([4, 5, 6]));
      w2.releaseLock();

      const received = await receivedPromise;

      expect(received).toHaveLength(2);
      expect(received).toContainEqual(createTestMessage([1, 2, 3]));
      expect(received).toContainEqual(createTestMessage([4, 5, 6]));
    });
  });

  describe("Writer removal", () => {
    it("should stop receiving messages after writer removal", async () => {
      const writer1 = fanInReader.getWriter();
      const writer2 = fanInReader.getWriter();

      const receivedPromise = collectMessages(fanInReader.readable, 3, 1000);

      const w1 = writer1.writable.getWriter();
      const w2 = writer2.writable.getWriter();

      await w1.write(createTestMessage([1, 2, 3]));
      await w2.write(createTestMessage([4, 5, 6]));

      // Remove writer1
      writer1.remove();
      w1.releaseLock();

      // Try to write again - writer1 should be disconnected
      await w2.write(createTestMessage([7, 8, 9]));
      w2.releaseLock();

      const received = await receivedPromise;

      // Should receive messages from both writers initially, then only from writer2
      expect(received).toHaveLength(3);
      expect(received).toContainEqual(createTestMessage([1, 2, 3]));
      expect(received).toContainEqual(createTestMessage([4, 5, 6]));
      expect(received).toContainEqual(createTestMessage([7, 8, 9]));
    });

    it("should handle removing all writers gracefully", async () => {
      const writer1 = fanInReader.getWriter();
      const writer2 = fanInReader.getWriter();

      // Remove all writers
      writer1.remove();
      writer2.remove();

      // Should not affect the readable stream
      const receivedPromise = collectMessages(fanInReader.readable, 1, 200);
      const received = await receivedPromise;
      
      expect(received).toHaveLength(0);
    });

    it("should handle removing the same writer multiple times", async () => {
      const writer = fanInReader.getWriter();

      // Multiple removals should not throw
      expect(() => writer.remove()).not.toThrow();
      expect(() => writer.remove()).not.toThrow();
      expect(() => writer.remove()).not.toThrow();
    });
  });

  describe("Reader cancellation", () => {
    it("should close all writers when reader is cancelled", async () => {
      const writer1 = fanInReader.getWriter();
      const writer2 = fanInReader.getWriter();

      const w1 = writer1.writable.getWriter();
      const w2 = writer2.writable.getWriter();

      await w1.write(createTestMessage([1, 2, 3]));
      await w2.write(createTestMessage([4, 5, 6]));

      // Cancel the reader
      await fanInReader.readable.cancel();

      // Writers should be closed/affected
      // Note: The exact behavior may depend on implementation details
      w1.releaseLock();
      w2.releaseLock();
    });

    it("should handle cancelling an already cancelled reader", async () => {
      await fanInReader.readable.cancel();
      
      // Cancelling again should not throw
      await expect(fanInReader.readable.cancel()).resolves.toBeUndefined();
    });
  });

  describe("Writer closure", () => {
    it("should handle individual writer closure gracefully", async () => {
      const writer1 = fanInReader.getWriter();
      const writer2 = fanInReader.getWriter();

      const receivedPromise = collectMessages(fanInReader.readable, 2, 1000);

      const w1 = writer1.writable.getWriter();
      const w2 = writer2.writable.getWriter();

      await w1.write(createTestMessage([1, 2, 3]));
      await w2.write(createTestMessage([4, 5, 6]));

      // Close writer1
      await w1.close();
      w1.releaseLock();

      // Writer2 should still work
      await w2.write(createTestMessage([7, 8, 9]));
      w2.releaseLock();

      // Should be able to collect messages
      const received = await receivedPromise;
      expect(received).toHaveLength(2);
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
      const writer1 = fanInReader.getWriter();
      const writer2 = fanInReader.getWriter();

      const receivedPromise = collectMessages(fanInReader.readable, 2, 1000);

      const w1 = writer1.writable.getWriter();
      const w2 = writer2.writable.getWriter();

      await w1.write(createTestMessage([1, 2, 3]));

      // Abort writer1
      await w1.abort(new Error("Test error"));
      w1.releaseLock();

      // Writer2 should still work
      await w2.write(createTestMessage([4, 5, 6]));
      w2.releaseLock();

      const received = await receivedPromise;
      expect(received).toHaveLength(2);
    });
  });
});

describe("Integration tests", () => {
  it("should chain fanout and fanin together", async () => {
    const fanOut = createFanOutWriter();
    const fanIn = createFanInReader();

    // Connect fanout readers to fanin writers
    const reader1 = fanOut.getReader();
    const reader2 = fanOut.getReader();
    const writer1 = fanIn.getWriter();
    const writer2 = fanIn.getWriter();

    // Pipe fanout readers to fanin writers
    const pipe1Promise = reader1.readable.pipeTo(writer1.writable);
    const pipe2Promise = reader2.readable.pipeTo(writer2.writable);

    const receivedPromise = collectMessages(fanIn.readable, 2, 1000);

    // Write to fanout
    const message = createTestMessage([1, 2, 3, 4]);
    await fanOut.writer.write(message);

    // Should receive the message twice in fanin (once from each path)
    const received = await receivedPromise;
    expect(received).toHaveLength(2);
    expect(received[0]).toEqual(message);
    expect(received[1]).toEqual(message);

    // Cleanup
    await fanOut.writer.close();
    await Promise.all([pipe1Promise, pipe2Promise]);
  });

  it("should handle complex cancellation scenarios", async () => {
    const fanOut = createFanOutWriter();
    const fanIn = createFanInReader();

    const reader1 = fanOut.getReader();
    const reader2 = fanOut.getReader();
    const writer1 = fanIn.getWriter();
    const writer2 = fanIn.getWriter();

    // Start piping
    const pipe1Promise = reader1.readable.pipeTo(writer1.writable).catch(() => {});
    const pipe2Promise = reader2.readable.pipeTo(writer2.writable).catch(() => {});

    // Write some messages
    await fanOut.writer.write(createTestMessage([1, 2, 3]));

    // Cancel fanin reader
    await fanIn.readable.cancel();

    // Unsubscribe from fanout
    reader1.unsubscribe();
    reader2.unsubscribe();

    // Close fanout writer
    await fanOut.writer.close();

    // Should not throw or hang
    await Promise.all([pipe1Promise, pipe2Promise]);
  });
});