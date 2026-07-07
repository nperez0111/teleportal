import type { RateLimitState, RateLimitStorage } from "teleportal/storage";

import { type DurableObjectStorageLike, KeyedMutex } from "./types";

type StoredRateLimitState = {
  state: RateLimitState;
  /** Absolute expiry timestamp — Durable Object storage has no TTL, so
   * writers stamp the deadline and readers treat expired state as absent. */
  expiresAt: number;
};

/**
 * Rate limit storage backed directly by Durable Object storage.
 *
 * Storage layout:
 * - `{prefix}:{key}` -- { state, expiresAt }
 */
export class DurableObjectRateLimitStorage implements RateLimitStorage {
  readonly #storage: DurableObjectStorageLike;
  readonly #keyPrefix: string;
  readonly #mutex = new KeyedMutex();

  constructor(
    storage: DurableObjectStorageLike,
    options?: {
      keyPrefix?: string;
    },
  ) {
    this.#storage = storage;
    this.#keyPrefix = options?.keyPrefix ?? "rate-limit";
  }

  #getKey(key: string): string {
    return `${this.#keyPrefix}:${key}`;
  }

  async #getFresh(key: string): Promise<RateLimitState | null> {
    const stored = await this.#storage.get<StoredRateLimitState>(this.#getKey(key));
    if (!stored) return null;
    if (stored.expiresAt <= Date.now()) {
      await this.#storage.delete(this.#getKey(key));
      return null;
    }
    return stored.state;
  }

  async getState(key: string): Promise<RateLimitState | null> {
    return this.#getFresh(key);
  }

  async setState(key: string, state: RateLimitState, ttl: number): Promise<void> {
    await this.#storage.put<StoredRateLimitState>(this.#getKey(key), {
      state,
      expiresAt: Date.now() + ttl,
    });
  }

  async deleteState(key: string): Promise<void> {
    await this.#storage.delete(this.#getKey(key));
  }

  async hasState(key: string): Promise<boolean> {
    return (await this.#getFresh(key)) !== null;
  }

  async transaction<T>(key: string, cb: () => Promise<T>): Promise<T> {
    return this.#mutex.run(this.#getKey(key), cb);
  }
}
