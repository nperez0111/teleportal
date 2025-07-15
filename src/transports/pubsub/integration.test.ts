import { describe, expect, it, beforeEach } from "bun:test";
import { Observable, DocMessage } from "teleportal";
import { Document } from "teleportal/server";
import {
  PubSubBackend,
  getPubSubTransport,
  InMemoryPubSubBackend,
} from "./index";

// Simulate a Redis-like backend for integration testing
class MockRedisBackend implements PubSubBackend {
  private subscribers = new Map<string, Set<(message: Uint8Array) => void>>();
  private publishLog: Array<{ topic: string; message: Uint8Array }> = [];

  async publish(topic: string, message: Uint8Array): Promise<void> {
    this.publishLog.push({ topic, message });

    const callbacks = this.subscribers.get(topic);
    if (callbacks) {
      // Simulate async delivery like Redis
      setTimeout(() => {
        for (const callback of Array.from(callbacks)) {
          try {
            callback(message);
          } catch (error) {
            console.error("Subscriber callback error:", error);
          }
        }
      }, 0);
    }
  }

  async subscribe(
    topic: string,
    callback: (message: Uint8Array) => void,
  ): Promise<() => Promise<void>> {
    if (!this.subscribers.has(topic)) {
      this.subscribers.set(topic, new Set());
    }

    const callbacks = this.subscribers.get(topic)!;
    callbacks.add(callback);

    return async () => {
      callbacks.delete(callback);
      if (callbacks.size === 0) {
        this.subscribers.delete(topic);
      }
    };
  }

  async close(): Promise<void> {
    this.subscribers.clear();
    this.publishLog = [];
  }

  // Helper methods for testing
  getPublishLog() {
    return this.publishLog;
  }

  getSubscriberCount(topic: string): number {
    return this.subscribers.get(topic)?.size ?? 0;
  }
}

describe("PubSub Transport Integration", () => {
  let redisBackend: MockRedisBackend;
  let inMemoryBackend: InMemoryPubSubBackend;

  beforeEach(() => {
    redisBackend = new MockRedisBackend();
    inMemoryBackend = new InMemoryPubSubBackend();
  });

  describe("Multi-Document Collaboration Scenario", () => {
    it("should handle multiple clients collaborating on different documents", async () => {
      // Setup two transport instances simulating different clients
      const client1Observer = new Observable<{
        subscribe: (topic: string) => void;
        unsubscribe: (topic: string) => void;
      }>();

      const client2Observer = new Observable<{
        subscribe: (topic: string) => void;
        unsubscribe: (topic: string) => void;
      }>();

      const client1Transport = getPubSubTransport({
        context: { clientId: "client-1" },
        backend: redisBackend,
        topicResolver: (message) => `doc:${Document.getDocumentId(message)}`,
        observer: client1Observer,
      });

      const client2Transport = getPubSubTransport({
        context: { clientId: "client-2" },
        backend: redisBackend,
        topicResolver: (message) => `doc:${Document.getDocumentId(message)}`,
        observer: client2Observer,
      });

      // Track received messages for each client
      const client1Messages: any[] = [];
      const client2Messages: any[] = [];

      // Setup message readers
      const client1Reader = client1Transport.readable.getReader();
      const client2Reader = client2Transport.readable.getReader();

      const client1ReadPromise = (async () => {
        try {
          while (true) {
            const result = await client1Reader.read();
            if (result.done) break;
            client1Messages.push(result.value);
          }
        } catch (error) {
          // Expected when closed
        }
      })();

      const client2ReadPromise = (async () => {
        try {
          while (true) {
            const result = await client2Reader.read();
            if (result.done) break;
            client2Messages.push(result.value);
          }
        } catch (error) {
          // Expected when closed
        }
      })();

      // Both clients subscribe to doc1
      client1Observer.call("subscribe", "doc:doc1");
      client2Observer.call("subscribe", "doc:doc1");

      // Client2 also subscribes to doc2
      client2Observer.call("subscribe", "doc:doc2");

      await new Promise((resolve) => setTimeout(resolve, 0));

      // Client1 makes changes to doc1
      const client1Writer = client1Transport.writable.getWriter();
      await client1Writer.write(
        new DocMessage(
          "doc1",
          { type: "update", update: new Uint8Array([1, 2, 3]) as any },
          { clientId: "client-1" },
        ),
      );

      // Client2 makes changes to doc2
      const client2Writer = client2Transport.writable.getWriter();
      await client2Writer.write(
        new DocMessage(
          "doc2",
          { type: "update", update: new Uint8Array([4, 5, 6]) as any },
          { clientId: "client-2" },
        ),
      );

      // Allow messages to propagate
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Verify message distribution
      expect(client1Messages).toHaveLength(1); // Should receive doc1 update
      expect(client2Messages).toHaveLength(2); // Should receive both doc1 and doc2 updates

      expect(client1Messages[0].document).toBe("doc1");
      expect(client2Messages.find((m) => m.document === "doc1")).toBeDefined();
      expect(client2Messages.find((m) => m.document === "doc2")).toBeDefined();

      // Cleanup
      await client1Transport.close();
      await client2Transport.close();
      await client1ReadPromise;
      await client2ReadPromise;
    });
  });

  describe("Dynamic Subscription Management", () => {
    it("should handle clients joining and leaving documents dynamically", async () => {
      const observer = new Observable<{
        subscribe: (topic: string) => void;
        unsubscribe: (topic: string) => void;
      }>();

      const transport = getPubSubTransport({
        context: { clientId: "dynamic-client" },
        backend: redisBackend,
        topicResolver: (message) => Document.getDocumentId(message),
        observer,
      });

      // Initially subscribe to doc1
      observer.call("subscribe", "doc1");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(redisBackend.getSubscriberCount("doc1")).toBe(1);

      // Add subscription to doc2
      observer.call("subscribe", "doc2");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(redisBackend.getSubscriberCount("doc2")).toBe(1);

      // Unsubscribe from doc1
      observer.call("unsubscribe", "doc1");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(redisBackend.getSubscriberCount("doc1")).toBe(0);
      expect(redisBackend.getSubscriberCount("doc2")).toBe(1);

      // Subscribe to doc1 again
      observer.call("subscribe", "doc1");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(redisBackend.getSubscriberCount("doc1")).toBe(1);

      await transport.close();
    });

    it("should not create duplicate subscriptions", async () => {
      const observer = new Observable<{
        subscribe: (topic: string) => void;
        unsubscribe: (topic: string) => void;
      }>();

      const transport = getPubSubTransport({
        backend: redisBackend,
        topicResolver: () => "test-topic",
        observer,
      });

      // Subscribe multiple times to same topic
      observer.call("subscribe", "test-topic");
      observer.call("subscribe", "test-topic");
      observer.call("subscribe", "test-topic");

      await new Promise((resolve) => setTimeout(resolve, 0));

      // Should only have one subscription
      expect(redisBackend.getSubscriberCount("test-topic")).toBe(1);

      await transport.close();
    });
  });

  describe("Cross-Backend Compatibility", () => {
    it("should work identically across different backend implementations", async () => {
      const testScenario = async (
        backend: PubSubBackend,
        backendName: string,
      ) => {
        const observer = new Observable<{
          subscribe: (topic: string) => void;
          unsubscribe: (topic: string) => void;
        }>();

        const transport = getPubSubTransport({
          context: { backend: backendName },
          backend,
          topicResolver: (message) =>
            `topic-${Document.getDocumentId(message)}`,
          observer,
        });

        const receivedMessages: any[] = [];

        // Setup reader
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

        // Subscribe and publish
        observer.call("subscribe", "topic-test-doc");
        await new Promise((resolve) => setTimeout(resolve, 0));

        const writer = transport.writable.getWriter();
        await writer.write(
          new DocMessage(
            "test-doc",
            { type: "update", update: new Uint8Array([1, 2, 3]) as any },
            { backend: backendName },
          ),
        );

        await new Promise((resolve) => setTimeout(resolve, 20));

        await transport.close();
        await readPromise;

        return receivedMessages;
      };

      // Test with both backends
      const redisResults = await testScenario(redisBackend, "redis");
      const inMemoryResults = await testScenario(inMemoryBackend, "inmemory");

      // Both should have received the message
      expect(redisResults).toHaveLength(1);
      expect(inMemoryResults).toHaveLength(1);

      // Message content should be equivalent
      expect(redisResults[0].document).toBe("test-doc");
      expect(inMemoryResults[0].document).toBe("test-doc");
    });
  });

  describe("Error Recovery and Resilience", () => {
    it("should continue working after backend errors", async () => {
      let shouldFail = true;

      class FlakeyBackend implements PubSubBackend {
        private actualBackend = new InMemoryPubSubBackend();

        async publish(topic: string, message: Uint8Array): Promise<void> {
          if (shouldFail) {
            shouldFail = false; // Fail once, then work
            throw new Error("Temporary backend failure");
          }
          return this.actualBackend.publish(topic, message);
        }

        async subscribe(
          topic: string,
          callback: (message: Uint8Array) => void,
        ): Promise<() => Promise<void>> {
          return this.actualBackend.subscribe(topic, callback);
        }

        async close(): Promise<void> {
          return this.actualBackend.close();
        }
      }

      const errors: Error[] = [];
      const observer = new Observable<{
        subscribe: (topic: string) => void;
        unsubscribe: (topic: string) => void;
      }>();

      const transport = getPubSubTransport({
        backend: new FlakeyBackend(),
        topicResolver: () => "test-topic",
        observer,
        onError: (error) => errors.push(error),
      });

      const writer = transport.writable.getWriter();

      // First write should fail
      await writer.write(
        new DocMessage(
          "doc1",
          { type: "update", update: new Uint8Array([1]) as any },
          { test: "first" },
        ),
      );

      // Second write should succeed
      await writer.write(
        new DocMessage(
          "doc2",
          { type: "update", update: new Uint8Array([2]) as any },
          { test: "second" },
        ),
      );

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("Temporary backend failure");

      await transport.close();
    });
  });

  describe("Performance Characteristics", () => {
    it("should handle high message throughput", async () => {
      const observer = new Observable<{
        subscribe: (topic: string) => void;
        unsubscribe: (topic: string) => void;
      }>();

      const transport = getPubSubTransport({
        backend: inMemoryBackend,
        topicResolver: (message) => "high-throughput-topic",
        observer,
      });

      const receivedMessages: any[] = [];

      // Setup reader
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

      observer.call("subscribe", "high-throughput-topic");
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Send many messages quickly
      const writer = transport.writable.getWriter();
      const messageCount = 100;

      const startTime = Date.now();

      for (let i = 0; i < messageCount; i++) {
        await writer.write(
          new DocMessage(
            "speed-test-doc",
            { type: "update", update: new Uint8Array([i % 256]) as any },
            { messageId: i },
          ),
        );
      }

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 50));

      const endTime = Date.now();
      const duration = endTime - startTime;

      await transport.close();
      await readPromise;

      expect(receivedMessages).toHaveLength(messageCount);
      expect(duration).toBeLessThan(1000); // Should complete within 1 second

      console.log(`Processed ${messageCount} messages in ${duration}ms`);
    });
  });

  describe("Memory Management", () => {
    it("should properly clean up resources on close", async () => {
      const observer = new Observable<{
        subscribe: (topic: string) => void;
        unsubscribe: (topic: string) => void;
      }>();

      const transport = getPubSubTransport({
        backend: redisBackend,
        topicResolver: () => "cleanup-topic",
        observer,
      });

      // Subscribe to topics
      observer.call("subscribe", "topic1");
      observer.call("subscribe", "topic2");
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(redisBackend.getSubscriberCount("topic1")).toBe(1);
      expect(redisBackend.getSubscriberCount("topic2")).toBe(1);

      // Close transport
      await transport.close();

      // All subscriptions should be cleaned up
      expect(redisBackend.getSubscriberCount("topic1")).toBe(0);
      expect(redisBackend.getSubscriberCount("topic2")).toBe(0);
      expect(observer.destroyed).toBe(true);
    });
  });
});
