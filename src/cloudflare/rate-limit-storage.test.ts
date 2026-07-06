import { beforeEach, describe, expect, it } from "bun:test";
import type { RateLimitState } from "teleportal/storage";

import { FakeDOStorage } from "./fake-do-storage";
import { DurableObjectRateLimitStorage } from "./rate-limit-storage";

describe("DurableObjectRateLimitStorage", () => {
  let storage: DurableObjectRateLimitStorage;

  const state: RateLimitState = {
    tokens: 10,
    lastRefill: 1234567890,
    windowMs: 1000,
    maxMessages: 10,
  };

  beforeEach(() => {
    storage = new DurableObjectRateLimitStorage(new FakeDOStorage());
  });

  it("stores and retrieves rate limit state", async () => {
    await storage.setState("test-key", state, 1000);
    expect(await storage.getState("test-key")).toEqual(state);
  });

  it("returns null for missing state", async () => {
    expect(await storage.getState("missing-key")).toBeNull();
  });

  it("expires state after its TTL (stamped expiry, no storage TTL)", async () => {
    await storage.setState("test-key", state, 1);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(await storage.getState("test-key")).toBeNull();
    expect(await storage.hasState("test-key")).toBe(false);
  });

  it("deletes state", async () => {
    await storage.setState("test-key", state, 1000);
    await storage.deleteState("test-key");
    expect(await storage.getState("test-key")).toBeNull();
  });

  it("hasState returns correct boolean", async () => {
    expect(await storage.hasState("test-key")).toBe(false);
    await storage.setState("test-key", state, 1000);
    expect(await storage.hasState("test-key")).toBe(true);
  });

  it("handles transactions sequentially", async () => {
    const executionOrder: string[] = [];

    const p1 = storage.transaction("test-key", async () => {
      executionOrder.push("start-1");
      await new Promise((resolve) => setTimeout(resolve, 1));
      executionOrder.push("end-1");
      return 1;
    });

    const p2 = storage.transaction("test-key", async () => {
      executionOrder.push("start-2");
      executionOrder.push("end-2");
      return 2;
    });

    await Promise.all([p1, p2]);

    expect(executionOrder).toEqual(["start-1", "end-1", "start-2", "end-2"]);
  });
});
