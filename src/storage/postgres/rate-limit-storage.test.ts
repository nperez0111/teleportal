import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { RateLimitState } from "../types";
import { PostgresRateLimitStorage } from "./rate-limit-storage";
import { dropSchema, ensureSchema } from "./schema";
import { isPostgresAvailable, makeTestSql, randomTablePrefix } from "./test-utils";
import type { Sql } from "./types";

let available = false;
let sql: (Sql & { end(): Promise<void> }) | undefined;
const prefix = randomTablePrefix();
const storages: PostgresRateLimitStorage[] = [];

function makeStorage(options?: { lockTimeoutMs?: number; cleanupProbability?: number }) {
  const storage = new PostgresRateLimitStorage(sql!, { tablePrefix: prefix, ...options });
  storages.push(storage);
  return storage;
}

function makeState(overrides: Partial<RateLimitState> = {}): RateLimitState {
  return {
    tokens: 10,
    lastRefill: 1_234_567_890,
    windowMs: 1000,
    maxMessages: 10,
    ...overrides,
  };
}

beforeAll(async () => {
  available = await isPostgresAvailable();
  if (!available) return;
  // Each adapter instance that runs a transaction() reserves one dedicated
  // lock connection, so the pool must be larger than the number of
  // concurrently open instances in this file.
  sql = makeTestSql(10);
  await ensureSchema(sql, { tablePrefix: prefix });
});

afterAll(async () => {
  for (const storage of storages) {
    await storage.close();
  }
  if (sql) {
    await dropSchema(sql, { tablePrefix: prefix });
    await sql.end();
  }
});

describe("PostgresRateLimitStorage", () => {
  it("stores and retrieves rate limit state", async () => {
    if (!available) return;
    const storage = makeStorage();
    const key = `rl-${crypto.randomUUID()}`;
    const state = makeState();
    await storage.setState(key, state, 60_000);
    expect(await storage.getState(key)).toEqual(state);
  });

  it("returns null for missing state", async () => {
    if (!available) return;
    const storage = makeStorage();
    expect(await storage.getState(`rl-${crypto.randomUUID()}`)).toBeNull();
  });

  it("deletes state", async () => {
    if (!available) return;
    const storage = makeStorage();
    const key = `rl-${crypto.randomUUID()}`;
    await storage.setState(key, makeState(), 60_000);
    await storage.deleteState(key);
    expect(await storage.getState(key)).toBeNull();
  });

  it("hasState returns correct boolean", async () => {
    if (!available) return;
    const storage = makeStorage();
    const key = `rl-${crypto.randomUUID()}`;
    expect(await storage.hasState(key)).toBe(false);
    await storage.setState(key, makeState(), 60_000);
    expect(await storage.hasState(key)).toBe(true);
  });

  it("overwrites existing state on repeated setState", async () => {
    if (!available) return;
    const storage = makeStorage();
    const key = `rl-${crypto.randomUUID()}`;
    await storage.setState(key, makeState({ tokens: 10 }), 60_000);
    const next = makeState({ tokens: 3, lastRefill: 42, windowMs: 500, maxMessages: 7 });
    await storage.setState(key, next, 60_000);
    expect(await storage.getState(key)).toEqual(next);
  });

  it("treats expired state as absent", async () => {
    if (!available) return;
    const storage = makeStorage();
    const key = `rl-${crypto.randomUUID()}`;
    await storage.setState(key, makeState(), 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await storage.getState(key)).toBeNull();
    expect(await storage.hasState(key)).toBe(false);
  });

  it("serializes concurrent transactions on the same key", async () => {
    if (!available) return;
    const storage = makeStorage();
    const key = `rl-${crypto.randomUUID()}`;
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        storage.transaction(key, async () => {
          order.push(i);
          // Yield so overlapping transactions would interleave if unlocked.
          await new Promise((resolve) => setTimeout(resolve, 1));
          order.push(i);
        }),
      ),
    );
    // Each transaction's two entries must be adjacent (no interleaving).
    for (let i = 0; i < order.length; i += 2) {
      expect(order[i]).toBe(order[i + 1]);
    }
    await storage.close();
  });

  it("physically removes expired rows during probabilistic cleanup", async () => {
    if (!available) return;
    const storage = makeStorage({ cleanupProbability: 1 });
    const expiredKey = `rl-${crypto.randomUUID()}`;
    await storage.setState(expiredKey, makeState(), 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Any write runs the sweep when cleanupProbability is 1.
    await storage.setState(`rl-${crypto.randomUUID()}`, makeState(), 60_000);
    const rows = (await sql!.unsafe(
      `SELECT count(*)::int AS count FROM ${prefix}rate_limits WHERE key = '${expiredKey}'`,
    )) as { count: number }[];
    expect(Number(rows[0].count)).toBe(0);
  });
});
