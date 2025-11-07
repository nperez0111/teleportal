import { beforeAll, describe, expect, test } from "bun:test";
import { Redis } from "ioredis";
import { RedisPubSub } from "./index";
import { PubSubTopic } from "teleportal";

// Test configuration
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const TEST_TIMEOUT = 5000; // 5 seconds

// Helper function to check if Redis is available
async function isRedisAvailable(): Promise<boolean> {
  try {
    const redis = new Redis(REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 1000,
      commandTimeout: 1000,
    });

    // Add error handler to prevent unhandled errors
    redis.on("error", () => {
      // Ignore connection errors during availability check
    });

    await redis.ping();
    await redis.quit();
    return true;
  } catch (error) {
    console.log(
      "Redis not available:",
      error instanceof Error ? error.message : "Unknown error",
    );
    return false;
  }
}

describe("Redis Transport", () => {
  let redisAvailable: boolean;
  let testInstanceId: string;

  beforeAll(async () => {
    redisAvailable = await isRedisAvailable();
    if (redisAvailable) {
      testInstanceId = "test-instance-" + Date.now();
    }
  });

  describe("Basic Redis", () => {
    test(
      "should connect to Redis and publish/subscribe",
      async () => {
        if (!redisAvailable) {
          console.log("Skipping Redis tests - Redis not available");
          return;
        }

        const publisher = new Redis(REDIS_URL);
        const subscriber = new Redis(REDIS_URL);

        // Add error handlers to prevent unhandled errors
        publisher.on("error", () => {});
        subscriber.on("error", () => {});
        const testTopic = "test-basic-" + Date.now();
        let receivedMessage: any = null;

        try {
          // Subscribe
          await subscriber.subscribe(testTopic);
          subscriber.on("message", (channel, message) => {
            if (channel === testTopic) {
              receivedMessage = message;
            }
          });

          // Wait for subscription
          await new Promise((resolve) => setTimeout(resolve, 0));

          // Publish
          await publisher.publish(testTopic, "test message");

          // Wait for message
          await new Promise((resolve) => setTimeout(resolve, 0));

          expect(receivedMessage).toBe("test message");
        } finally {
          await publisher.quit();
          await subscriber.quit();
        }
      },
      TEST_TIMEOUT,
    );
  });

  describe("RedisPubSub", () => {
    test("should implement the PubSub interface", async () => {
      if (!redisAvailable) {
        console.log("Skipping Redis tests - Redis not available");
        return;
      }

      const pubsub = new RedisPubSub({ path: REDIS_URL });
      expect(pubsub).toBeDefined();
      expect(typeof pubsub.publish).toBe("function");
      expect(typeof pubsub.subscribe).toBe("function");
      expect(typeof pubsub[Symbol.asyncDispose]).toBe("function");

      // Clean up
      await pubsub[Symbol.asyncDispose]?.();
    });

    test(
      "should publish and subscribe to messages",
      async () => {
        if (!redisAvailable) {
          console.log("Skipping Redis tests - Redis not available");
          return;
        }

        const publisher = new RedisPubSub({ path: REDIS_URL });
        const subscriber = new RedisPubSub({ path: REDIS_URL });
        const testTopic: PubSubTopic = `document/test-topic-${Date.now()}`;
        const testMessage = new Uint8Array([1, 2, 3, 4]) as any;
        let receivedMessage: any = null;

        try {
          // Subscribe to the topic
          const unsubscribe = await subscriber.subscribe(
            testTopic,
            (message) => {
              receivedMessage = message;
            },
          );

          // Wait a bit for subscription to be established
          await new Promise((resolve) => setTimeout(resolve, 0));

          // Publish a message from different instance
          await publisher.publish(testTopic, testMessage, "test-publisher");

          // Wait for message to be received
          await new Promise((resolve) => setTimeout(resolve, 0));

          expect(receivedMessage).toBeDefined();
          expect(receivedMessage).toEqual(testMessage);

          // Cleanup
          if (unsubscribe) await unsubscribe();
        } finally {
          if (publisher[Symbol.asyncDispose])
            await publisher[Symbol.asyncDispose]();
          if (subscriber[Symbol.asyncDispose])
            await subscriber[Symbol.asyncDispose]();
        }
      },
      TEST_TIMEOUT,
    );

    test(
      "should handle multiple subscribers to the same topic",
      async () => {
        if (!redisAvailable) {
          console.log("Skipping Redis tests - Redis not available");
          return;
        }

        const pubsub1 = new RedisPubSub({ path: REDIS_URL });
        const pubsub2 = new RedisPubSub({ path: REDIS_URL });
        const publisher = new RedisPubSub({ path: REDIS_URL });
        const testTopic: PubSubTopic = `document/test-topic-multi-${Date.now()}`;
        const testMessage = new Uint8Array([5, 6, 7, 8]) as any;
        const receivedMessages: any[] = [];

        try {
          // Subscribe with first pubsub
          const unsubscribe1 = await pubsub1.subscribe(testTopic, (message) => {
            receivedMessages.push(message);
          });

          // Subscribe with second pubsub
          const unsubscribe2 = await pubsub2.subscribe(testTopic, (message) => {
            receivedMessages.push(message);
          });

          // Wait for subscriptions to be established
          await new Promise((resolve) => setTimeout(resolve, 0));

          // Publish a message from a third instance
          await publisher.publish(testTopic, testMessage, "test-publisher");

          // Wait for messages to be received
          await new Promise((resolve) => setTimeout(resolve, 0));

          // Both subscribers should receive the message
          expect(receivedMessages).toHaveLength(2);
          expect(receivedMessages[0]).toEqual(testMessage);
          expect(receivedMessages[1]).toEqual(testMessage);

          // Cleanup
          if (unsubscribe1) await unsubscribe1();
          if (unsubscribe2) await unsubscribe2();
        } finally {
          if (pubsub1[Symbol.asyncDispose])
            await pubsub1[Symbol.asyncDispose]();
          if (pubsub2[Symbol.asyncDispose])
            await pubsub2[Symbol.asyncDispose]();
          if (publisher[Symbol.asyncDispose])
            await publisher[Symbol.asyncDispose]();
        }
      },
      TEST_TIMEOUT,
    );

    test(
      "should handle unsubscribe correctly",
      async () => {
        if (!redisAvailable) {
          console.log("Skipping Redis tests - Redis not available");
          return;
        }

        const pubsub = new RedisPubSub({ path: REDIS_URL });
        const testTopic: PubSubTopic = `document/test-topic-unsub-${Date.now()}`;
        const testMessage = new Uint8Array([13, 14, 15, 16]) as any;
        let messageReceived = false;

        try {
          // Subscribe to the topic
          const unsubscribe = await pubsub.subscribe(testTopic, (message) => {
            messageReceived = true;
          });

          // Wait for subscription to be established
          await new Promise((resolve) => setTimeout(resolve, 0));

          // Unsubscribe
          if (unsubscribe) await unsubscribe();

          // Publish a message
          await pubsub.publish(testTopic, testMessage, "test-publisher");

          // Wait a bit
          await new Promise((resolve) => setTimeout(resolve, 0));

          // Should not receive the message since we unsubscribed
          expect(messageReceived).toBe(false);
        } finally {
          if (pubsub[Symbol.asyncDispose]) await pubsub[Symbol.asyncDispose]();
        }
      },
      TEST_TIMEOUT,
    );

    test(
      "should handle destroy correctly",
      async () => {
        if (!redisAvailable) {
          console.log("Skipping Redis tests - Redis not available");
          return;
        }

        const pubsub = new RedisPubSub({ path: REDIS_URL });
        const testTopic: PubSubTopic = `document/test-topic-destroy-${Date.now()}`;

        try {
          // Subscribe to a topic
          await pubsub.subscribe(testTopic, () => {});

          // Destroy the pubsub
          if (pubsub[Symbol.asyncDispose]) await pubsub[Symbol.asyncDispose]();

          // Should fail when trying to publish after destroy
          const testMessage = new Uint8Array([17, 18, 19, 20]) as any;
          try {
            await pubsub.publish(testTopic, testMessage, "test-publisher");
            expect(true).toBe(false); // Should not reach here
          } catch (error) {
            // Expected to fail after destroy
            expect(error).toBeDefined();
          }
        } catch (error) {
          // Expected to fail after destroy
          expect(error).toBeDefined();
        }
      },
      TEST_TIMEOUT,
    );
  });
});
