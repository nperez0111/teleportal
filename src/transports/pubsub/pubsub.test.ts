import { describe, expect, it, beforeEach } from "bun:test";
import { Observable, DocMessage, AwarenessMessage, type Message } from "teleportal";
import { Document } from "teleportal/server";
import {
  PubSubBackend,
  getPubSubSink,
  getPubSubSource,
  getPubSubTransport,
  InMemoryPubSubBackend,
} from "./index";

// Mock backend for testing error scenarios
class MockFailureBackend implements PubSubBackend {
  public publishCallCount = 0;
  public subscribeCallCount = 0;
  public closeCallCount = 0;
  public shouldFailPublish = false;
  public shouldFailSubscribe = false;

  async publish(topic: string, message: Uint8Array): Promise<void> {
    this.publishCallCount++;
    if (this.shouldFailPublish) {
      throw new Error(`Mock publish failure for topic: ${topic}`);
    }
  }

  async subscribe(
    topic: string,
    callback: (message: Uint8Array) => void,
  ): Promise<() => Promise<void>> {
    this.subscribeCallCount++;
    if (this.shouldFailSubscribe) {
      throw new Error(`Mock subscribe failure for topic: ${topic}`);
    }
    
    return async () => {
      // Mock unsubscribe
    };
  }

  async close(): Promise<void> {
    this.closeCallCount++;
  }
}

// Helper to create test messages
function createTestDocMessage(documentId: string, contextId: string): Message<{ test: string }> {
  return new DocMessage(
    documentId,
    {
      type: "update",
      update: new Uint8Array([0x01, 0x02, 0x03, 0x04]) as any,
    },
    { test: contextId },
  );
}

function createTestAwarenessMessage(documentId: string, contextId: string): Message<{ test: string }> {
  return new AwarenessMessage(
    documentId,
    {
      type: "awareness-update",
      update: new Uint8Array([0x01, 0x02, 0x03, 0x04]) as any,
    },
    { test: contextId },
  );
}

describe("PubSub Transport", () => {
  let mockBackend: MockFailureBackend;
  let inMemoryBackend: InMemoryPubSubBackend;
  let observer: Observable<{
    subscribe: (topic: string) => void;
    unsubscribe: (topic: string) => void;
  }>;

  beforeEach(() => {
    mockBackend = new MockFailureBackend();
    inMemoryBackend = new InMemoryPubSubBackend();
    observer = new Observable<{
      subscribe: (topic: string) => void;
      unsubscribe: (topic: string) => void;
    }>();
  });

  describe("InMemoryPubSubBackend", () => {
    it("should publish and receive messages", async () => {
      const receivedMessages: Uint8Array[] = [];
      const testMessage = new Uint8Array([1, 2, 3, 4, 5]);

      const unsubscribe = await inMemoryBackend.subscribe("test-topic", (message) => {
        receivedMessages.push(message);
      });

      await inMemoryBackend.publish("test-topic", testMessage);

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0]).toEqual(testMessage);

      await unsubscribe();
    });

    it("should handle multiple subscribers", async () => {
      const messages1: Uint8Array[] = [];
      const messages2: Uint8Array[] = [];
      const testMessage = new Uint8Array([1, 2, 3]);

      const unsub1 = await inMemoryBackend.subscribe("test-topic", (msg) => messages1.push(msg));
      const unsub2 = await inMemoryBackend.subscribe("test-topic", (msg) => messages2.push(msg));

      await inMemoryBackend.publish("test-topic", testMessage);

      expect(messages1).toHaveLength(1);
      expect(messages2).toHaveLength(1);
      expect(messages1[0]).toEqual(testMessage);
      expect(messages2[0]).toEqual(testMessage);

      await unsub1();
      await unsub2();
    });

    it("should handle different topics independently", async () => {
      const topic1Messages: Uint8Array[] = [];
      const topic2Messages: Uint8Array[] = [];
      const message1 = new Uint8Array([1, 1, 1]);
      const message2 = new Uint8Array([2, 2, 2]);

      const unsub1 = await inMemoryBackend.subscribe("topic1", (msg) => topic1Messages.push(msg));
      const unsub2 = await inMemoryBackend.subscribe("topic2", (msg) => topic2Messages.push(msg));

      await inMemoryBackend.publish("topic1", message1);
      await inMemoryBackend.publish("topic2", message2);

      expect(topic1Messages).toHaveLength(1);
      expect(topic2Messages).toHaveLength(1);
      expect(topic1Messages[0]).toEqual(message1);
      expect(topic2Messages[0]).toEqual(message2);

      await unsub1();
      await unsub2();
    });

    it("should handle unsubscribe correctly", async () => {
      const receivedMessages: Uint8Array[] = [];
      const testMessage = new Uint8Array([1, 2, 3]);

      const unsubscribe = await inMemoryBackend.subscribe("test-topic", (message) => {
        receivedMessages.push(message);
      });

      await inMemoryBackend.publish("test-topic", testMessage);
      expect(receivedMessages).toHaveLength(1);

      await unsubscribe();
      await inMemoryBackend.publish("test-topic", testMessage);
      expect(receivedMessages).toHaveLength(1); // Should not receive second message
    });

    it("should clean up topics when all subscribers are removed", async () => {
      const unsubscribe = await inMemoryBackend.subscribe("test-topic", () => {});
      await unsubscribe();

      // Internal verification - check that topic is cleaned up
      expect((inMemoryBackend as any).subscribers.has("test-topic")).toBe(false);
    });

    it("should handle errors in subscriber callbacks gracefully", async () => {
      const goodMessages: Uint8Array[] = [];
      const testMessage = new Uint8Array([1, 2, 3]);

      // Add a subscriber that throws an error
      await inMemoryBackend.subscribe("test-topic", () => {
        throw new Error("Subscriber error");
      });

      // Add a good subscriber
      const unsubscribe = await inMemoryBackend.subscribe("test-topic", (msg) => {
        goodMessages.push(msg);
      });

      // Publishing should not fail even if one subscriber throws
      await expect(inMemoryBackend.publish("test-topic", testMessage)).resolves.not.toThrow();
      expect(goodMessages).toHaveLength(1);

      await unsubscribe();
    });
  });

  describe("getPubSubSink", () => {
    it("should publish messages using the backend", async () => {
      const sink = getPubSubSink({
        backend: mockBackend,
        topicResolver: (message) => `topic-${Document.getDocumentId(message)}`,
      });

      const writer = sink.writable.getWriter();
      const testMessage = createTestDocMessage("test-doc", "test-context");

      await writer.write(testMessage);

      expect(mockBackend.publishCallCount).toBe(1);
      await writer.close();
    });

    it("should use custom topic resolver", async () => {
      const publishedTopics: string[] = [];
      
      class CustomBackend implements PubSubBackend {
        async publish(topic: string, message: Uint8Array): Promise<void> {
          publishedTopics.push(topic);
        }
        async subscribe(): Promise<() => Promise<void>> {
          return async () => {};
        }
        async close(): Promise<void> {}
      }

      const sink = getPubSubSink({
        backend: new CustomBackend(),
        topicResolver: (message) => `custom-${message.context.test}`,
      });

      const writer = sink.writable.getWriter();
      await writer.write(createTestDocMessage("doc1", "ctx1"));
      await writer.write(createTestDocMessage("doc2", "ctx2"));

      expect(publishedTopics).toEqual(["custom-ctx1", "custom-ctx2"]);
      await writer.close();
    });

    it("should handle publish errors with custom error handler", async () => {
      const errors: Error[] = [];
      mockBackend.shouldFailPublish = true;

      const sink = getPubSubSink({
        backend: mockBackend,
        topicResolver: (message) => "test-topic",
        onError: (error) => errors.push(error),
      });

      const writer = sink.writable.getWriter();
      await writer.write(createTestDocMessage("test-doc", "test-context"));

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("Mock publish failure");
      await writer.close();
    });

    it("should handle both doc and awareness messages", async () => {
      const sink = getPubSubSink({
        backend: mockBackend,
        topicResolver: (message) => `${message.type}-topic`,
      });

      const writer = sink.writable.getWriter();
      await writer.write(createTestDocMessage("doc1", "ctx1"));
      await writer.write(createTestAwarenessMessage("doc2", "ctx2"));

      expect(mockBackend.publishCallCount).toBe(2);
      await writer.close();
    });
  });

  describe("getPubSubSource", () => {
    it("should subscribe to topics via observer", async () => {
      const source = getPubSubSource({
        context: { test: "base-context" },
        backend: inMemoryBackend,
        observer,
      });

      // Subscribe to a topic
      observer.emit("subscribe", "test-topic");

      expect(source.backend).toBe(inMemoryBackend);
      expect(source.observer).toBe(observer);

      await source.readable.cancel();
    });

    it("should receive messages from subscribed topics", async () => {
      const receivedMessages: Message<{ test: string }>[] = [];
      
      const source = getPubSubSource({
        context: { test: "base-context" },
        backend: inMemoryBackend,
        observer,
      });

      // Start reading messages
      const reader = source.readable.getReader();
      const readPromise = (async () => {
        try {
          const result = await reader.read();
          if (!result.done) {
            receivedMessages.push(result.value);
          }
        } catch (error) {
          // Expected when we cancel
        }
      })();

      // Subscribe to topic
      observer.emit("subscribe", "test-topic");

      // Allow subscription to complete
      await new Promise(resolve => setTimeout(resolve, 0));

      // Publish a message
      const testMessage = createTestDocMessage("test-doc", "test-context");
      await inMemoryBackend.publish("test-topic", testMessage.encoded);

      // Allow message processing
      await new Promise(resolve => setTimeout(resolve, 10));

      await source.readable.cancel();
      await readPromise;

      expect(receivedMessages).toHaveLength(1);
    });

    it("should handle subscription errors with custom error handler", async () => {
      const errors: Error[] = [];
      mockBackend.shouldFailSubscribe = true;

      const source = getPubSubSource({
        context: { test: "base-context" },
        backend: mockBackend,
        observer,
        onError: (error) => errors.push(error),
      });

      observer.emit("subscribe", "test-topic");

      // Allow error to propagate
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("Mock subscribe failure");

      await source.readable.cancel();
    });

    it("should handle unsubscribe", async () => {
      const source = getPubSubSource({
        context: { test: "base-context" },
        backend: inMemoryBackend,
        observer,
      });

      // Subscribe then unsubscribe
      observer.emit("subscribe", "test-topic");
      await new Promise(resolve => setTimeout(resolve, 0));
      
      observer.emit("unsubscribe", "test-topic");
      await new Promise(resolve => setTimeout(resolve, 0));

      await source.readable.cancel();
    });

    it("should not subscribe to the same topic twice", async () => {
      let subscribeCount = 0;
      
      class CountingBackend implements PubSubBackend {
        async publish(): Promise<void> {}
        async subscribe(): Promise<() => Promise<void>> {
          subscribeCount++;
          return async () => {};
        }
        async close(): Promise<void> {}
      }

      const source = getPubSubSource({
        context: { test: "base-context" },
        backend: new CountingBackend(),
        observer,
      });

      observer.emit("subscribe", "test-topic");
      observer.emit("subscribe", "test-topic"); // Should not subscribe again

      await new Promise(resolve => setTimeout(resolve, 0));

      expect(subscribeCount).toBe(1);
      await source.readable.cancel();
    });
  });

  describe("getPubSubTransport", () => {
    it("should create a working transport", async () => {
      const transport = getPubSubTransport({
        context: { test: "base-context" },
        backend: inMemoryBackend,
        topicResolver: (message) => Document.getDocumentId(message),
        observer,
      });

      expect(transport.readable).toBeDefined();
      expect(transport.writable).toBeDefined();
      expect(transport.backend).toBe(inMemoryBackend);
      expect(transport.observer).toBe(observer);

      await transport.close();
    });

    it("should enable end-to-end message flow", async () => {
      const transport = getPubSubTransport({
        context: { test: "base-context" },
        backend: inMemoryBackend,
        topicResolver: (message) => Document.getDocumentId(message),
        observer,
      });

      const receivedMessages: Message<{ test: string }>[] = [];
      
      // Start reading messages
      const reader = transport.readable.getReader();
      const readPromise = (async () => {
        try {
          while (true) {
            const result = await reader.read();
            if (result.done) break;
            receivedMessages.push(result.value);
          }
        } catch (error) {
          // Expected when transport is closed
        }
      })();

      // Subscribe to the document topic
      observer.emit("subscribe", "test-doc");
      await new Promise(resolve => setTimeout(resolve, 0));

      // Write a message
      const writer = transport.writable.getWriter();
      const testMessage = createTestDocMessage("test-doc", "test-context");
      await writer.write(testMessage);

      // Allow message to flow through
      await new Promise(resolve => setTimeout(resolve, 10));

      await transport.close();
      await readPromise;

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0].document).toBe("test-doc");
    });

    it("should handle different document topics", async () => {
      const transport = getPubSubTransport({
        context: { test: "base-context" },
        backend: inMemoryBackend,
        topicResolver: (message) => Document.getDocumentId(message),
        observer,
      });

      const receivedMessages: Message<{ test: string }>[] = [];
      
      // Start reading
      const reader = transport.readable.getReader();
      const readPromise = (async () => {
        try {
          while (true) {
            const result = await reader.read();
            if (result.done) break;
            receivedMessages.push(result.value);
          }
        } catch (error) {
          // Expected
        }
      })();

      // Subscribe to multiple documents
      observer.emit("subscribe", "doc1");
      observer.emit("subscribe", "doc2");
      await new Promise(resolve => setTimeout(resolve, 0));

      // Write messages to different documents
      const writer = transport.writable.getWriter();
      await writer.write(createTestDocMessage("doc1", "ctx1"));
      await writer.write(createTestDocMessage("doc2", "ctx2"));

      await new Promise(resolve => setTimeout(resolve, 10));

      await transport.close();
      await readPromise;

      expect(receivedMessages).toHaveLength(2);
      const documentIds = receivedMessages.map(m => m.document);
      expect(documentIds).toContain("doc1");
      expect(documentIds).toContain("doc2");
    });

    it("should handle errors with custom error handler", async () => {
      const errors: Error[] = [];
      mockBackend.shouldFailPublish = true;

      const transport = getPubSubTransport({
        context: { test: "base-context" },
        backend: mockBackend,
        topicResolver: (message) => "test-topic",
        observer,
        onError: (error) => errors.push(error),
      });

      const writer = transport.writable.getWriter();
      await writer.write(createTestDocMessage("test-doc", "test-context"));

      expect(errors).toHaveLength(1);
      await transport.close();
    });
  });

  describe("Error Handling", () => {
    it("should handle backend close errors gracefully", async () => {
      class FailingCloseBackend implements PubSubBackend {
        async publish(): Promise<void> {}
        async subscribe(): Promise<() => Promise<void>> {
          return async () => {};
        }
        async close(): Promise<void> {
          throw new Error("Close failed");
        }
      }

      const transport = getPubSubTransport({
        backend: new FailingCloseBackend(),
        topicResolver: () => "topic",
        observer,
      });

      // Should not throw even if backend close fails
      await expect(transport.close()).resolves.not.toThrow();
    });

    it("should handle message processing errors", async () => {
      const errors: Error[] = [];
      
      const source = getPubSubSource({
        context: { test: "base-context" },
        backend: inMemoryBackend,
        observer,
        onError: (error) => errors.push(error),
      });

      // Start reading
      const reader = source.readable.getReader();
      const readPromise = reader.read().catch(() => {
        // Expected to fail
      });

      observer.emit("subscribe", "test-topic");
      await new Promise(resolve => setTimeout(resolve, 0));

      // Publish invalid message data
      await inMemoryBackend.publish("test-topic", new Uint8Array([0xFF, 0xFF]));
      await new Promise(resolve => setTimeout(resolve, 10));

      await source.readable.cancel();
      await readPromise;

      // Should have captured message processing error
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe("Observable Integration", () => {
    it("should properly manage observer lifecycle", async () => {
      const transport = getPubSubTransport({
        backend: inMemoryBackend,
        topicResolver: () => "topic",
        observer,
      });

      // Observer should be active
      expect(observer.destroyed).toBe(false);

      await transport.close();

      // Observer should be destroyed after close
      expect(observer.destroyed).toBe(true);
    });

    it("should handle observer destruction gracefully", async () => {
      const source = getPubSubSource({
        backend: inMemoryBackend,
        observer,
      });

      observer.destroy();

      // Should handle destroyed observer gracefully
      await expect(source.readable.cancel()).resolves.not.toThrow();
    });
  });
});