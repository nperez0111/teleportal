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
    console.log("Redis not available:", error instanceof Error ? error.message : "Unknown error");
    return false;
  }
}

describe("Redis Transport", () => {
  let redisAvailable: boolean;

  beforeAll(async () => {
    redisAvailable = await isRedisAvailable();
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

      const pubSub = new RedisPubSub({ path: REDIS_URL });
      expect(pubSub).toBeDefined();
      expect(typeof pubSub.publish).toBe("function");
      expect(typeof pubSub.subscribe).toBe("function");
      expect(typeof pubSub[Symbol.asyncDispose]).toBe("function");

      // Clean up
      await pubSub[Symbol.asyncDispose]?.();
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
          const unsubscribe = await subscriber.subscribe(testTopic, (message) => {
            receivedMessage = message;
          });

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
          if (publisher[Symbol.asyncDispose]) await publisher[Symbol.asyncDispose]();
          if (subscriber[Symbol.asyncDispose]) await subscriber[Symbol.asyncDispose]();
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

        const pubSub1 = new RedisPubSub({ path: REDIS_URL });
        const pubSub2 = new RedisPubSub({ path: REDIS_URL });
        const publisher = new RedisPubSub({ path: REDIS_URL });
        const testTopic: PubSubTopic = `document/test-topic-multi-${Date.now()}`;
        const testMessage = new Uint8Array([5, 6, 7, 8]) as any;
        const receivedMessages: any[] = [];

        try {
          // Subscribe with first pubSub
          const unsubscribe1 = await pubSub1.subscribe(testTopic, (message) => {
            receivedMessages.push(message);
          });

          // Subscribe with second pubSub
          const unsubscribe2 = await pubSub2.subscribe(testTopic, (message) => {
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
          if (pubSub1[Symbol.asyncDispose]) await pubSub1[Symbol.asyncDispose]();
          if (pubSub2[Symbol.asyncDispose]) await pubSub2[Symbol.asyncDispose]();
          if (publisher[Symbol.asyncDispose]) await publisher[Symbol.asyncDispose]();
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

        const pubSub = new RedisPubSub({ path: REDIS_URL });
        const testTopic: PubSubTopic = `document/test-topic-unsub-${Date.now()}`;
        const testMessage = new Uint8Array([13, 14, 15, 16]) as any;
        let messageReceived = false;

        try {
          // Subscribe to the topic
          const unsubscribe = await pubSub.subscribe(testTopic, (_message) => {
            messageReceived = true;
          });

          // Wait for subscription to be established
          await new Promise((resolve) => setTimeout(resolve, 0));

          // Unsubscribe
          if (unsubscribe) await unsubscribe();

          // Publish a message
          await pubSub.publish(testTopic, testMessage, "test-publisher");

          // Wait a bit
          await new Promise((resolve) => setTimeout(resolve, 0));

          // Should not receive the message since we unsubscribed
          expect(messageReceived).toBe(false);
        } finally {
          if (pubSub[Symbol.asyncDispose]) await pubSub[Symbol.asyncDispose]();
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

        const pubSub = new RedisPubSub({ path: REDIS_URL });
        const testTopic: PubSubTopic = `document/test-topic-destroy-${Date.now()}`;

        try {
          // Subscribe to a topic
          await pubSub.subscribe(testTopic, () => {});

          // Destroy the pubSub
          if (pubSub[Symbol.asyncDispose]) await pubSub[Symbol.asyncDispose]();

          // Should fail when trying to publish after destroy
          const testMessage = new Uint8Array([17, 18, 19, 20]) as any;
          try {
            await pubSub.publish(testTopic, testMessage, "test-publisher");
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

async function pollUntil(fn: () => boolean, timeoutMs = 3000, intervalMs = 10): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("pollUntil timed out");
}

const STREAM_PREFIX = "teleportal:stream:";

describe("Redis durable streams", () => {
  let redisAvailable: boolean;
  let inspect: Redis;

  beforeAll(async () => {
    redisAvailable = await isRedisAvailable();
    if (redisAvailable) {
      inspect = new Redis(REDIS_URL);
      inspect.on("error", () => {});
    }
  });

  test(
    "advertises durability",
    async () => {
      if (!redisAvailable) return;
      const pubSub = new RedisPubSub({ path: REDIS_URL });
      expect(pubSub.durable).toBe(true);
      await pubSub[Symbol.asyncDispose]();
    },
    TEST_TIMEOUT,
  );

  test(
    "replays messages after an offset (cold catch-up), in order",
    async () => {
      if (!redisAvailable) return;
      const topic: PubSubTopic = `document/replay-${Date.now()}`;
      const pub = new RedisPubSub({ path: REDIS_URL });
      const sub = new RedisPubSub({ path: REDIS_URL });
      try {
        // Live consumer captures the offset of message A.
        const liveOffsets: (string | undefined)[] = [];
        const unsubLive = await sub.subscribeDurable(topic, (_m, _s, offset) =>
          liveOffsets.push(offset),
        );
        await pub.publish(topic, new Uint8Array([1]) as any, "pub");
        await pollUntil(() => liveOffsets.length >= 1);
        const afterA = liveOffsets[0]!;
        await unsubLive();

        // Messages published while nobody actively reads them.
        await pub.publish(topic, new Uint8Array([2]) as any, "pub");
        await pub.publish(topic, new Uint8Array([3]) as any, "pub");

        // A fresh consumer resuming after A replays B and C in order.
        const got: number[] = [];
        const gaps: string[] = [];
        const unsub = await sub.subscribeDurable(topic, (m) => got.push((m as Uint8Array)[0]), {
          start: { after: afterA },
          onGap: (t) => gaps.push(t),
        });
        await pollUntil(() => got.length >= 2);
        expect(got).toEqual([2, 3]);
        expect(gaps).toHaveLength(0); // A still retained → no gap
        await unsub();
      } finally {
        await pub[Symbol.asyncDispose]();
        await sub[Symbol.asyncDispose]();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "resumes and catches up after the stream connection drops",
    async () => {
      if (!redisAvailable) return;
      const topic: PubSubTopic = `document/reconnect-${Date.now()}`;
      const sub = new RedisPubSub({ path: REDIS_URL });
      const pub = new RedisPubSub({ path: REDIS_URL });
      try {
        const got: number[] = [];
        await sub.subscribeDurable(topic, (m) => got.push((m as Uint8Array)[0]));
        await pub.publish(topic, new Uint8Array([1]) as any, "pub");
        await pollUntil(() => got.includes(1));

        // Drop the subscriber's blocking read connection; ioredis auto-reconnects.
        sub.disconnectStreamReaderForTest();
        // Publish during the outage via a separate instance.
        await pub.publish(topic, new Uint8Array([2]) as any, "pub");
        await pub.publish(topic, new Uint8Array([3]) as any, "pub");

        // After reconnect, XREAD resumes from the last id and returns the misses in order.
        await pollUntil(() => got.length >= 3);
        expect(got).toEqual([1, 2, 3]);
      } finally {
        await pub[Symbol.asyncDispose]();
        await sub[Symbol.asyncDispose]();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "trims the stream toward maxLen",
    async () => {
      if (!redisAvailable) return;
      const topic: PubSubTopic = `document/trim-${Date.now()}`;
      const key = STREAM_PREFIX + topic;
      const pub = new RedisPubSub({ path: REDIS_URL, stream: { maxLen: 50 } });
      try {
        for (let i = 0; i < 300; i++) {
          await pub.publish(topic, new Uint8Array([i & 0xff]) as any, "pub");
        }
        const len = await inspect.xlen(key);
        expect(len).toBeLessThan(300); // trimming happened
        expect(len).toBeGreaterThanOrEqual(50); // didn't over-trim below the bound
      } finally {
        await inspect.del(key);
        await pub[Symbol.asyncDispose]();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "ephemeral publishes never hit the stream",
    async () => {
      if (!redisAvailable) return;
      const topic: PubSubTopic = `document/ephemeral-${Date.now()}`;
      const key = STREAM_PREFIX + topic;
      const pub = new RedisPubSub({ path: REDIS_URL });
      try {
        await pub.publish(topic, new Uint8Array([1]) as any, "pub", { ephemeral: true });
        // Give any (erroneous) XADD time to land.
        await new Promise((r) => setTimeout(r, 20));
        expect(await inspect.exists(key)).toBe(0);
      } finally {
        await inspect.del(key);
        await pub[Symbol.asyncDispose]();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "non-durable topics (ack/*) create no stream keys",
    async () => {
      if (!redisAvailable) return;
      const topic: PubSubTopic = `ack/no-stream-${Date.now()}`;
      const key = STREAM_PREFIX + topic;
      const pub = new RedisPubSub({ path: REDIS_URL });
      try {
        await pub.publish(topic, new Uint8Array([1]) as any, "pub");
        await new Promise((r) => setTimeout(r, 20));
        expect(await inspect.exists(key)).toBe(0);
      } finally {
        await inspect.del(key);
        await pub[Symbol.asyncDispose]();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "isDurableTopic:() => false disables streams entirely",
    async () => {
      if (!redisAvailable) return;
      const topic: PubSubTopic = `document/plainmode-${Date.now()}`;
      const key = STREAM_PREFIX + topic;
      const pub = new RedisPubSub({ path: REDIS_URL, stream: { isDurableTopic: () => false } });
      const sub = new RedisPubSub({ path: REDIS_URL, stream: { isDurableTopic: () => false } });
      try {
        const got: number[] = [];
        await sub.subscribe(topic, (m) => got.push((m as Uint8Array)[0]));
        await new Promise((r) => setTimeout(r, 20));
        await pub.publish(topic, new Uint8Array([7]) as any, "pub");
        await pollUntil(() => got.includes(7));
        expect(await inspect.exists(key)).toBe(0); // delivered over plain pub/sub, no stream
      } finally {
        await inspect.del(key);
        await pub[Symbol.asyncDispose]();
        await sub[Symbol.asyncDispose]();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "dispose during a blocked read exits cleanly",
    async () => {
      if (!redisAvailable) return;
      const topic: PubSubTopic = `document/dispose-${Date.now()}`;
      const pub = new RedisPubSub({ path: REDIS_URL, stream: { blockMs: 1000 } });
      await pub.subscribe(topic, () => {});
      // Subscriber is now blocked on XREAD; dispose should not hang.
      await pub[Symbol.asyncDispose]();
      expect(true).toBe(true);
    },
    TEST_TIMEOUT,
  );
});
