import { describe, it, expect, beforeEach, mock } from "bun:test";
import { RedisRateLimitStorage } from "./rate-limit-storage";
import type { Redis } from "ioredis";

describe("RedisRateLimitStorage", () => {
  let storage: RedisRateLimitStorage;
  let mockRedis: any;

  beforeEach(() => {
    mockRedis = {
      hgetall: mock(),
      multi: mock().mockReturnThis(),
      hmset: mock().mockReturnThis(),
      expire: mock().mockReturnThis(),
      exec: mock().mockResolvedValue([]),
      del: mock().mockResolvedValue(1),
      exists: mock().mockResolvedValue(0),
      set: mock().mockResolvedValue("OK"),
      eval: mock().mockResolvedValue(1),
    } as unknown as Redis;

    storage = new RedisRateLimitStorage(mockRedis as Redis);
  });

  it("getState retrieves data from Redis", async () => {
    mockRedis.hgetall.mockResolvedValue({
      tokens: "5",
      lastRefill: "1000",
      windowMs: "1000",
      maxMessages: "10",
    });

    const state = await storage.getState("test");
    expect(state).toEqual({
      tokens: 5,
      lastRefill: 1000,
      windowMs: 1000,
      maxMessages: 10,
    });
    expect(mockRedis.hgetall).toHaveBeenCalledWith("teleportal:ratelimit:test");
  });

  it("getState returns null if no data", async () => {
    mockRedis.hgetall.mockResolvedValue({});
    const state = await storage.getState("test");
    expect(state).toBeNull();
  });

  it("setState writes data to Redis", async () => {
    const state = {
      tokens: 10,
      lastRefill: 2000,
      windowMs: 1000,
      maxMessages: 10,
    };

    await storage.setState("test", state, 5000);

    expect(mockRedis.multi).toHaveBeenCalled();
    expect(mockRedis.hmset).toHaveBeenCalledWith(
      "teleportal:ratelimit:test",
      state,
    );
    expect(mockRedis.expire).toHaveBeenCalledWith(
      "teleportal:ratelimit:test",
      5,
    );
    expect(mockRedis.exec).toHaveBeenCalled();
  });

  it("transaction acquires and releases lock", async () => {
    const cb = mock().mockResolvedValue("result");
    const result = await storage.transaction("test", cb);

    expect(result).toBe("result");
    // Acquire lock
    expect(mockRedis.set).toHaveBeenCalledWith(
      "teleportal:ratelimit:test:lock",
      expect.any(String),
      "PX",
      5000,
      "NX",
    );
    // Callback executed
    expect(cb).toHaveBeenCalled();
    // Release lock (via Lua)
    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.stringContaining('if redis.call("get", KEYS[1]) == ARGV[1] then'),
      1,
      "teleportal:ratelimit:test:lock",
      expect.any(String),
    );
  });

  it("transaction retries if lock is taken", async () => {
    // Fail first 2 times, succeed 3rd time
    mockRedis.set
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("OK");

    const cb = mock().mockResolvedValue("success");
    const result = await storage.transaction("test", cb);

    expect(result).toBe("success");
    expect(mockRedis.set).toHaveBeenCalledTimes(3);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("transaction throws if lock cannot be acquired", async () => {
    // Always fail
    mockRedis.set.mockResolvedValue(null);

    // Speed up retries for test
    const start = Date.now();
    try {
      await storage.transaction("test", async () => {});
      expect(true).toBe(false); // Should not reach here
    } catch (e: any) {
      expect(e.message).toContain("Failed to acquire rate limit lock");
    }
  });
});
