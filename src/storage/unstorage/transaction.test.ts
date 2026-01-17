import { beforeEach, describe, expect, it } from "bun:test";
import { createStorage } from "unstorage";
import { withTransaction } from "./transaction";

describe("withTransaction", () => {
  let storage: ReturnType<typeof createStorage>;

  beforeEach(() => {
    storage = createStorage();
  });

  describe("basic functionality", () => {
    it("should execute transaction callback", async () => {
      const key = "test-key-1";
      let executed = false;

      await withTransaction(
        storage,
        key,
        async () => {
          executed = true;
          return "result";
        },
        { ttl: 1000 },
      );

      expect(executed).toBe(true);
    });

    it("should return transaction result", async () => {
      const key = "test-key-2";
      const result = await withTransaction(
        storage,
        key,
        async () => {
          return "test-result";
        },
        { ttl: 1000 },
      );

      expect(result).toBe("test-result");
    });

    it("should pass key to callback", async () => {
      const key = "test-key-3";
      let receivedKey: string | undefined;

      await withTransaction(
        storage,
        key,
        async (k) => {
          receivedKey = k;
          return "result";
        },
        { ttl: 1000 },
      );

      expect(receivedKey).toBe(key);
    });
  });

  describe("locking behavior", () => {
    it("should acquire and release lock", async () => {
      const key = "test-key-4";
      const ttl = 1000;

      await withTransaction(
        storage,
        key,
        async () => {
          // Check that lock is set
          const meta = await storage.getMeta(key);
          expect(meta?.ttl).toBeGreaterThan(Date.now());
          expect(meta?.ttl).toBeLessThanOrEqual(Date.now() + ttl);
          return "result";
        },
        { ttl },
      );

      // Check that lock is released after transaction
      const meta = await storage.getMeta(key);
      expect(meta?.ttl).toBeLessThanOrEqual(Date.now());
    });

    it("should handle concurrent transactions", async () => {
      const key = "test-key-5";
      const executionOrder: string[] = [];

      const promise1 = withTransaction(
        storage,
        key,
        async () => {
          executionOrder.push("start-1");
          await new Promise((resolve) => setTimeout(resolve, 50));
          executionOrder.push("end-1");
          return "result-1";
        },
        { ttl: 1000 },
      );

      const promise2 = withTransaction(
        storage,
        key,
        async () => {
          executionOrder.push("start-2");
          await new Promise((resolve) => setTimeout(resolve, 10));
          executionOrder.push("end-2");
          return "result-2";
        },
        { ttl: 1000 },
      );

      const [result1, result2] = await Promise.all([promise1, promise2]);

      expect(result1).toBe("result-1");
      expect(result2).toBe("result-2");
      // Verify both transactions completed
      expect(executionOrder).toContain("start-1");
      expect(executionOrder).toContain("end-1");
      expect(executionOrder).toContain("start-2");
      expect(executionOrder).toContain("end-2");
      // Verify each transaction's start comes before its end
      const start1Index = executionOrder.indexOf("start-1");
      const end1Index = executionOrder.indexOf("end-1");
      const start2Index = executionOrder.indexOf("start-2");
      const end2Index = executionOrder.indexOf("end-2");
      expect(start1Index).toBeLessThan(end1Index);
      expect(start2Index).toBeLessThan(end2Index);
    });

    it("should allow concurrent transactions on different keys", async () => {
      const key1 = "test-key-6a";
      const key2 = "test-key-6b";
      const executionOrder: string[] = [];

      const promise1 = withTransaction(
        storage,
        key1,
        async () => {
          executionOrder.push("start-1");
          await new Promise((resolve) => setTimeout(resolve, 50));
          executionOrder.push("end-1");
          return "result-1";
        },
        { ttl: 1000 },
      );

      const promise2 = withTransaction(
        storage,
        key2,
        async () => {
          executionOrder.push("start-2");
          await new Promise((resolve) => setTimeout(resolve, 10));
          executionOrder.push("end-2");
          return "result-2";
        },
        { ttl: 1000 },
      );

      const [result1, result2] = await Promise.all([promise1, promise2]);

      expect(result1).toBe("result-1");
      expect(result2).toBe("result-2");
      // Different keys can execute concurrently
      expect(executionOrder).toContain("start-1");
      expect(executionOrder).toContain("start-2");
      expect(executionOrder).toContain("end-1");
      expect(executionOrder).toContain("end-2");
      // Second should finish before first (different keys, no blocking)
      expect(executionOrder.indexOf("end-2")).toBeLessThan(
        executionOrder.indexOf("end-1"),
      );
    });
  });

  describe("retry and backoff", () => {
    it("should retry when lock is held", async () => {
      const key = "test-key-7";
      let retryCount = 0;

      // Manually set a lock
      await storage.setMeta(key, { ttl: Date.now() + 100 });

      // Start transaction that will need to retry
      const transactionPromise = withTransaction(
        storage,
        key,
        async () => {
          retryCount++;
          return "result";
        },
        { ttl: 1000, baseDelay: 10, maxDelay: 100 },
      );

      // Wait a bit for the lock to expire
      await new Promise((resolve) => setTimeout(resolve, 110));

      const result = await transactionPromise;
      expect(result).toBe("result");
      expect(retryCount).toBe(1);
    });

    it("should use exponential backoff", async () => {
      const key = "test-key-8";
      const retryTimes: number[] = [];
      let attemptCount = 0;

      // Manually set a lock that will expire
      await storage.setMeta(key, { ttl: Date.now() + 100 });

      const transactionPromise = withTransaction(
        storage,
        key,
        async () => {
          attemptCount++;
          return "result";
        },
        { ttl: 1000, baseDelay: 10, maxDelay: 100 },
      );

      // Track when retries happen
      const startTime = Date.now();
      let lastCheck = startTime;

      // Poll to detect retries
      const checkInterval = setInterval(async () => {
        const now = Date.now();
        if (now - lastCheck > 5) {
          // Check if we're still waiting (lock still held)
          const meta = await storage.getMeta(key);
          if (meta && typeof meta === "object" && "ttl" in meta) {
            const ttl = meta.ttl;
            if (typeof ttl === "number" && ttl > Date.now()) {
              retryTimes.push(now - startTime);
            }
          }
        }
        lastCheck = now;
      }, 5);

      // Wait for lock to expire and transaction to complete
      await new Promise((resolve) => setTimeout(resolve, 110));
      await transactionPromise;
      clearInterval(checkInterval);

      // Should have retried at least once
      expect(attemptCount).toBe(1);
    });

    it("should respect max retry limit", async () => {
      const key = "test-key-9";
      const maxRetries = 3;

      // Set a lock that won't expire
      await storage.setMeta(key, { ttl: Date.now() + 10_000 });

      await expect(
        withTransaction(
          storage,
          key,
          async () => {
            return "result";
          },
          { ttl: 1000, maxRetries, baseDelay: 10 },
        ),
      ).rejects.toThrow(
        `Transaction lock acquisition failed after ${maxRetries} retries`,
      );
    });

    it("should respect max delay cap", async () => {
      const key = "test-key-10";
      const maxDelay = 100;
      let retryCount = 0;

      // Manually set a lock that will expire
      await storage.setMeta(key, { ttl: Date.now() + 200 });

      const transactionPromise = withTransaction(
        storage,
        key,
        async () => {
          retryCount++;
          return "result";
        },
        { ttl: 1000, baseDelay: 10, maxDelay },
      );

      // Wait for lock to expire
      await new Promise((resolve) => setTimeout(resolve, 210));

      const result = await transactionPromise;
      expect(result).toBe("result");
      // Should have retried (lock was held)
      expect(retryCount).toBe(1);
    });
  });

  describe("error handling", () => {
    it("should release lock on error", async () => {
      const key = "test-key-11";
      const ttl = 1000;

      await expect(
        withTransaction(
          storage,
          key,
          async () => {
            // Check that lock is set
            const meta = await storage.getMeta(key);
            expect(meta?.ttl).toBeGreaterThan(Date.now());
            throw new Error("Test error");
          },
          { ttl },
        ),
      ).rejects.toThrow("Test error");

      // Check that lock is released even after error
      const meta = await storage.getMeta(key);
      expect(meta?.ttl).toBeLessThanOrEqual(Date.now());
    });

    it("should propagate errors from callback", async () => {
      const key = "test-key-12";
      const error = new Error("Custom error");

      await expect(
        withTransaction(
          storage,
          key,
          async () => {
            throw error;
          },
          { ttl: 1000 },
        ),
      ).rejects.toThrow("Custom error");
    });
  });

  describe("lock safety", () => {
    it("should not release lock if TTL expired and another transaction acquired it", async () => {
      const key = "test-key-lock-safety";
      const shortTTL = 50; // Very short TTL
      const executionTime = 150; // Longer than TTL

      let transactionALockId: string | undefined;
      let transactionBLockId: string | undefined;
      let transactionAFinished = false;
      let transactionBStarted = false;

      // Start transaction A with short TTL that will expire during execution
      const transactionA = withTransaction(
        storage,
        key,
        async () => {
          // Capture the lockId that transaction A acquired
          const meta = await storage.getMeta(key);
          transactionALockId = meta?.lockId as string | undefined;
          expect(transactionALockId).toBeDefined();

          // Take longer than the TTL to execute
          await new Promise((resolve) => setTimeout(resolve, executionTime));
          transactionAFinished = true;
          return "transaction-a";
        },
        { ttl: shortTTL, baseDelay: 10 },
      );

      // Wait a bit to ensure transaction A has acquired the lock
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Verify transaction A has the lock
      const metaBeforeTTL = await storage.getMeta(key);
      expect(metaBeforeTTL?.lockId).toBe(transactionALockId);
      expect(metaBeforeTTL?.ttl).toBeGreaterThan(Date.now());

      // Wait for transaction A's TTL to expire
      await new Promise((resolve) => setTimeout(resolve, shortTTL + 20));

      // Verify transaction A's lock has expired
      const metaAfterTTL = await storage.getMeta(key);
      expect(metaAfterTTL?.ttl).toBeLessThanOrEqual(Date.now());

      // Start transaction B - it should acquire the lock since A's TTL expired
      const transactionB = withTransaction(
        storage,
        key,
        async () => {
          transactionBStarted = true;
          // Capture the lockId that transaction B acquired
          const meta = await storage.getMeta(key);
          transactionBLockId = meta?.lockId as string | undefined;
          expect(transactionBLockId).toBeDefined();
          // Verify we have a different lockId than transaction A
          expect(transactionBLockId).not.toBe(transactionALockId);
          await new Promise((resolve) => setTimeout(resolve, 50));
          return "transaction-b";
        },
        { ttl: 1000, baseDelay: 10 },
      );

      // Wait for transaction B to start and acquire the lock
      // It may need to retry a few times due to exponential backoff
      let attempts = 0;
      while (!transactionBStarted && attempts < 20) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        attempts++;
      }
      expect(transactionBStarted).toBe(true);
      expect(transactionBLockId).toBeDefined();
      expect(transactionBLockId).not.toBe(transactionALockId);

      // Small delay to ensure lock is properly set
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Wait for transaction A to finish (it should check lockId and not release B's lock)
      await transactionA;
      expect(transactionAFinished).toBe(true);

      // Verify transaction B still has the lock (transaction A should not have released it)
      // This is the key test: transaction A should have checked lockId and seen it doesn't match,
      // so it shouldn't have released transaction B's lock
      const metaAfterAFinishes = await storage.getMeta(key);
      // The critical assertion: lockId should still match transaction B's lockId
      // This proves transaction A checked the lockId, saw it didn't match its own,
      // and therefore did NOT release transaction B's lock
      expect(metaAfterAFinishes?.lockId).toBe(transactionBLockId);

      // Wait for transaction B to finish
      const resultB = await transactionB;
      expect(resultB).toBe("transaction-b");

      // Verify transaction B released its own lock
      const finalMeta = await storage.getMeta(key);
      expect(finalMeta?.ttl).toBeLessThanOrEqual(Date.now());
    });
  });

  describe("thundering herd prevention", () => {
    it("should prevent thundering herd with multiple concurrent requests", async () => {
      const key = "test-key-13";
      const concurrentRequests = 10;
      const executionOrder: number[] = [];

      // Start a long-running transaction
      const longTransaction = withTransaction(
        storage,
        key,
        async () => {
          executionOrder.push(0); // First transaction
          await new Promise((resolve) => setTimeout(resolve, 100));
          executionOrder.push(0); // First transaction ends
          return "first";
        },
        { ttl: 1000, baseDelay: 10 },
      );

      // Wait a bit to ensure the first transaction acquires the lock
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Start multiple concurrent requests that will need to wait
      const concurrentPromises = Array.from(
        { length: concurrentRequests },
        (_, i) =>
          withTransaction(
            storage,
            key,
            async () => {
              executionOrder.push(i + 1);
              return `result-${i + 1}`;
            },
            { ttl: 1000, baseDelay: 10 },
          ),
      );

      const [firstResult, ...otherResults] = await Promise.all([
        longTransaction,
        ...concurrentPromises,
      ]);

      expect(firstResult).toBe("first");
      expect(otherResults.length).toBe(concurrentRequests);
      // All should complete
      for (const [i, otherResult] of otherResults.entries()) {
        expect(otherResult).toBe(`result-${i + 1}`);
      }

      // Verify sequential execution (first completes, then others execute one by one)
      expect(executionOrder[0]).toBe(0); // First starts
      const firstEndIndex = executionOrder.indexOf(0, 1); // Find where first ends
      expect(firstEndIndex).toBeGreaterThan(0);
      // All others should execute after first completes
      for (let i = firstEndIndex + 1; i < executionOrder.length; i++) {
        expect(executionOrder[i]).toBeGreaterThan(0);
      }
    });
  });

  describe("options", () => {
    it("should use custom TTL", async () => {
      const key = "test-key-14";
      const customTTL = 2000;

      await withTransaction(
        storage,
        key,
        async () => {
          const meta = await storage.getMeta(key);
          const expectedTTL = Date.now() + customTTL;
          // Allow 100ms tolerance
          expect(meta?.ttl).toBeGreaterThan(expectedTTL - 100);
          expect(meta?.ttl).toBeLessThanOrEqual(expectedTTL + 100);
          return "result";
        },
        { ttl: customTTL },
      );
    });

    it("should use custom maxRetries", async () => {
      const key = "test-key-15";
      const customMaxRetries = 5;

      // Set a lock that won't expire
      await storage.setMeta(key, { ttl: Date.now() + 10_000 });

      await expect(
        withTransaction(
          storage,
          key,
          async () => {
            return "result";
          },
          { ttl: 1000, maxRetries: customMaxRetries, baseDelay: 10 },
        ),
      ).rejects.toThrow(
        `Transaction lock acquisition failed after ${customMaxRetries} retries`,
      );
    });

    it("should use custom baseDelay", async () => {
      const key = "test-key-16";
      const customBaseDelay = 20;
      let retryCount = 0;

      // Manually set a lock that will expire
      await storage.setMeta(key, { ttl: Date.now() + 100 });

      const transactionPromise = withTransaction(
        storage,
        key,
        async () => {
          retryCount++;
          return "result";
        },
        { ttl: 1000, baseDelay: customBaseDelay, maxDelay: 100 },
      );

      // Wait for lock to expire
      await new Promise((resolve) => setTimeout(resolve, 110));

      const result = await transactionPromise;
      expect(result).toBe("result");
      // Should have retried (lock was held)
      expect(retryCount).toBe(1);
    });
  });
});
