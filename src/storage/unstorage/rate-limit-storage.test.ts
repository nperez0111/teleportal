import { beforeEach, describe, expect, it } from "bun:test";
import { createStorage } from "unstorage";
import { UnstorageRateLimitStorage } from "./rate-limit-storage";
import type { RateLimitState } from "../types";

describe("UnstorageRateLimitStorage", () => {
  let storage: UnstorageRateLimitStorage;
  let unstorage: ReturnType<typeof createStorage>;

  beforeEach(() => {
    unstorage = createStorage();
    storage = new UnstorageRateLimitStorage(unstorage);
  });

  it("stores and retrieves rate limit state", async () => {
    const key = "test-key";
    const state: RateLimitState = {
      tokens: 10,
      lastRefill: 1234567890,
      windowMs: 1000,
      maxMessages: 10,
    };

    await storage.setState(key, state, 1000);
    const retrieved = await storage.getState(key);

    expect(retrieved).toEqual(state);
  });

  it("returns null for missing state", async () => {
    const retrieved = await storage.getState("missing-key");
    expect(retrieved).toBeNull();
  });

  it("deletes state", async () => {
    const key = "test-key";
    const state: RateLimitState = {
      tokens: 10,
      lastRefill: 1234567890,
      windowMs: 1000,
      maxMessages: 10,
    };

    await storage.setState(key, state, 1000);
    await storage.deleteState(key);
    const retrieved = await storage.getState(key);

    expect(retrieved).toBeNull();
  });

  it("hasState returns correct boolean", async () => {
    const key = "test-key";
    const state: RateLimitState = {
      tokens: 10,
      lastRefill: 1234567890,
      windowMs: 1000,
      maxMessages: 10,
    };

    expect(await storage.hasState(key)).toBe(false);
    await storage.setState(key, state, 1000);
    expect(await storage.hasState(key)).toBe(true);
  });

  it("handles transactions sequentially", async () => {
    const key = "test-key";
    const executionOrder: string[] = [];

    // Start transaction 1 (slower)
    const p1 = storage.transaction(key, async () => {
      executionOrder.push("start-1");
      await new Promise((resolve) => setTimeout(resolve, 50));
      executionOrder.push("end-1");
      return 1;
    });

    // Start transaction 2 (faster, but should wait for 1)
    const p2 = storage.transaction(key, async () => {
      executionOrder.push("start-2");
      executionOrder.push("end-2");
      return 2;
    });

    await Promise.all([p1, p2]);

    expect(executionOrder.length).toBe(4);
    if (executionOrder[0] === "start-1") {
      expect(executionOrder).toEqual(["start-1", "end-1", "start-2", "end-2"]);
    } else {
      expect(executionOrder).toEqual(["start-2", "end-2", "start-1", "end-1"]);
    }
  });
});
