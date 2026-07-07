import { describe, expect, it, beforeEach } from "bun:test";
import type { RateLimitState, RateLimitStorage } from "./types";
import { TieredRateLimitStorage } from "./tiered-rate-limit-storage";

class MockRateLimitStorage implements RateLimitStorage {
  #store = new Map<string, { state: RateLimitState; expiresAt: number }>();
  getCalls = 0;
  setCalls = 0;
  deleteCalls = 0;
  hasCalls = 0;
  transactionCalls = 0;

  async getState(key: string): Promise<RateLimitState | null> {
    this.getCalls++;
    const entry = this.#store.get(key);
    if (!entry || Date.now() >= entry.expiresAt) return null;
    return entry.state;
  }

  async setState(key: string, state: RateLimitState, ttl: number): Promise<void> {
    this.setCalls++;
    this.#store.set(key, { state, expiresAt: Date.now() + ttl });
  }

  async deleteState(key: string): Promise<void> {
    this.deleteCalls++;
    this.#store.delete(key);
  }

  async hasState(key: string): Promise<boolean> {
    this.hasCalls++;
    const entry = this.#store.get(key);
    return entry != null && Date.now() < entry.expiresAt;
  }

  async transaction<T>(key: string, cb: () => Promise<T>): Promise<T> {
    this.transactionCalls++;
    return cb();
  }
}

function makeState(tokens: number): RateLimitState {
  return { tokens, lastRefill: Date.now(), windowMs: 60_000, maxMessages: 100 };
}

describe("TieredRateLimitStorage", () => {
  let backing: MockRateLimitStorage;
  let tiered: TieredRateLimitStorage;

  beforeEach(() => {
    backing = new MockRateLimitStorage();
    tiered = new TieredRateLimitStorage(backing);
  });

  it("cache hit: setState then getState returns cached value without hitting backing", async () => {
    const state = makeState(42);
    await tiered.setState("k1", state, 60_000);
    backing.getCalls = 0;

    const result = await tiered.getState("k1");
    expect(result).toEqual(state);
    expect(backing.getCalls).toBe(0);
  });

  it("cache miss falls through to backing store", async () => {
    const state = makeState(10);
    await backing.setState("k1", state, 60_000);
    backing.getCalls = 0;

    const fresh = new TieredRateLimitStorage(backing);
    const result = await fresh.getState("k1");
    expect(result).toEqual(state);
    expect(backing.getCalls).toBe(1);
  });

  it("expired cache entries fall through to backing", async () => {
    const state = makeState(5);
    await tiered.setState("k1", state, 1);

    await new Promise((resolve) => setTimeout(resolve, 1));

    const freshState = makeState(99);
    await backing.setState("k1", freshState, 60_000);
    backing.getCalls = 0;

    const result = await tiered.getState("k1");
    expect(result).toEqual(freshState);
    expect(backing.getCalls).toBe(1);
  });

  it("LRU eviction: oldest entry is evicted when cache is full", async () => {
    const small = new TieredRateLimitStorage(backing, { maxCacheSize: 2 });

    await small.setState("a", makeState(1), 60_000);
    await small.setState("b", makeState(2), 60_000);
    await small.setState("c", makeState(3), 60_000);

    backing.getCalls = 0;
    const resultC = await small.getState("c");
    expect(resultC?.tokens).toBe(3);
    expect(backing.getCalls).toBe(0);

    const resultB = await small.getState("b");
    expect(resultB?.tokens).toBe(2);
    expect(backing.getCalls).toBe(0);

    // "a" was evicted — falls through to backing
    const resultA = await small.getState("a");
    expect(resultA?.tokens).toBe(1);
    expect(backing.getCalls).toBe(1);
  });

  it("deleteState removes from cache so next get falls through", async () => {
    await tiered.setState("k1", makeState(7), 60_000);
    await tiered.deleteState("k1");

    backing.getCalls = 0;
    const result = await tiered.getState("k1");
    expect(result).toBeNull();
    expect(backing.getCalls).toBe(1);
  });

  it("hasState checks cache first without hitting backing", async () => {
    await tiered.setState("k1", makeState(1), 60_000);
    backing.hasCalls = 0;

    const result = await tiered.hasState("k1");
    expect(result).toBe(true);
    expect(backing.hasCalls).toBe(0);
  });

  it("hasState falls through when not cached", async () => {
    await backing.setState("k1", makeState(1), 60_000);
    backing.hasCalls = 0;

    const fresh = new TieredRateLimitStorage(backing);
    const result = await fresh.hasState("k1");
    expect(result).toBe(true);
    expect(backing.hasCalls).toBe(1);
  });

  it("transaction delegates to backing store", async () => {
    const result = await tiered.transaction("k1", async () => 42);
    expect(result).toBe(42);
    expect(backing.transactionCalls).toBe(1);
  });
});
