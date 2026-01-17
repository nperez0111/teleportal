import { Redis } from "ioredis";
import type { RateLimitState, RateLimitStorage } from "../../storage/types";

/**
 * Redis implementation of RateLimitStorage.
 *
 * This implementation allows sharing rate limit state across multiple server instances.
 * It uses Redis for storage and implements a simple distributed lock for transactions.
 */
export class RedisRateLimitStorage implements RateLimitStorage {
  constructor(
    private redis: Redis,
    private prefix: string = "teleportal:ratelimit:",
    private lockTtl: number = 5000,
  ) {}

  private getKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  async getState(key: string): Promise<RateLimitState | null> {
    const data = await this.redis.hgetall(this.getKey(key));

    if (!data || Object.keys(data).length === 0) {
      return null;
    }

    return {
      tokens: Number(data.tokens),
      lastRefill: Number(data.lastRefill),
      windowMs: Number(data.windowMs),
      maxMessages: Number(data.maxMessages),
    };
  }

  async setState(
    key: string,
    state: RateLimitState,
    ttl: number,
  ): Promise<void> {
    const redisKey = this.getKey(key);
    // Convert TTL to seconds for Redis EXPIRE, ensure at least 1 second
    const ttlSeconds = Math.max(1, Math.ceil(ttl / 1000));

    await this.redis
      .multi()
      .hmset(redisKey, {
        tokens: state.tokens,
        lastRefill: state.lastRefill,
        windowMs: state.windowMs,
        maxMessages: state.maxMessages,
      })
      .expire(redisKey, ttlSeconds)
      .exec();
  }

  async deleteState(key: string): Promise<void> {
    await this.redis.del(this.getKey(key));
  }

  async hasState(key: string): Promise<boolean> {
    return (await this.redis.exists(this.getKey(key))) === 1;
  }

  async transaction<T>(key: string, cb: () => Promise<T>): Promise<T> {
    const lockKey = `${this.getKey(key)}:lock`;
    const lockValue = Math.random().toString(36).substring(2);
    const retryDelay = 50;
    const maxRetries = 20; // 1 second total wait time

    for (let i = 0; i < maxRetries; i++) {
      // Try to acquire lock
      const acquired = await this.redis.set(
        lockKey,
        lockValue,
        "PX",
        this.lockTtl,
        "NX",
      );

      if (acquired === "OK") {
        try {
          return await cb();
        } finally {
          // Release lock only if we still hold it
          // Use Lua script to check value before deleting to avoid deleting others' locks
          // if TTL expired and someone else acquired it.
          const releaseScript = `
            if redis.call("get", KEYS[1]) == ARGV[1] then
              return redis.call("del", KEYS[1])
            else
              return 0
            end
          `;
          await this.redis.eval(releaseScript, 1, lockKey, lockValue);
        }
      }

      // Wait before retrying
      await new Promise((resolve) =>
        setTimeout(resolve, retryDelay + Math.random() * 20),
      );
    }

    throw new Error(`Failed to acquire rate limit lock for key: ${key}`);
  }
}
