import type { Storage } from "unstorage";
import type { RateLimitState, RateLimitStorage } from "../types";
import { type TransactionOptions, withTransaction } from "./transaction";

export class UnstorageRateLimitStorage implements RateLimitStorage {
  constructor(
    private storage: Storage,
    private transactionOptions: TransactionOptions = { ttl: 5000 },
  ) {}

  async getState(key: string): Promise<RateLimitState | null> {
    return (await this.storage.getItem<RateLimitState>(key)) || null;
  }

  async setState(
    key: string,
    state: RateLimitState,
    ttl: number,
  ): Promise<void> {
    // Convert TTL from milliseconds to seconds for unstorage
    const ttlSeconds = Math.ceil(ttl / 1000);
    await this.storage.setItem(key, state, { ttl: ttlSeconds });
  }

  async deleteState(key: string): Promise<void> {
    await this.storage.removeItem(key);
  }

  async hasState(key: string): Promise<boolean> {
    return await this.storage.hasItem(key);
  }

  async transaction<T>(key: string, cb: () => Promise<T>): Promise<T> {
    // Use a separate lock key to avoid interfering with the actual data
    // and to allow locking even if the data doesn't exist yet
    const lockKey = `lock:${key}`;

    // wrapper to match withTransaction signature and ignore the passed key
    return withTransaction(
      this.storage,
      lockKey,
      () => cb(),
      this.transactionOptions,
    );
  }
}
