import type { RateLimitState, RateLimitStorage } from "./types";

/**
 * A tiered rate limit storage that wraps any {@link RateLimitStorage} with an
 * in-memory LRU cache.
 *
 * - **Reads** hit the cache first; on miss they fall through to the backing store.
 * - **Writes** are write-through: the cache is updated synchronously and the
 *   backing store write is fire-and-forget (the returned promise resolves as
 *   soon as the cache is updated).
 * - **Transactions** delegate locking to the backing store while reads/writes
 *   inside the callback still benefit from the cache (the rate limiter calls
 *   `storage.getState` / `storage.setState` on the same `storage` reference
 *   that owns the transaction).
 *
 * Since rate limit state is ephemeral and TTL-based, slight cache staleness is
 * acceptable — a marginally stale token count does not compromise correctness.
 *
 * Eviction is insertion-order (Map iteration order), which approximates LRU for
 * the typical rate-limit access pattern where keys are touched in rapid bursts.
 */
export class TieredRateLimitStorage implements RateLimitStorage {
  #cache = new Map<string, { state: RateLimitState; expiresAt: number }>();
  #backing: RateLimitStorage;
  #maxCacheSize: number;
  #onBackingError?: (error: unknown) => void;

  constructor(
    backing: RateLimitStorage,
    opts?: { maxCacheSize?: number; onBackingError?: (error: unknown) => void },
  ) {
    this.#backing = backing;
    this.#maxCacheSize = opts?.maxCacheSize ?? 10_000;
    this.#onBackingError = opts?.onBackingError;
  }

  async getState(key: string): Promise<RateLimitState | null> {
    const cached = this.#cache.get(key);
    if (cached) {
      if (Date.now() < cached.expiresAt) return cached.state;
      this.#cache.delete(key);
    }
    return this.#backing.getState(key);
  }

  async setState(key: string, state: RateLimitState, ttl: number): Promise<void> {
    // Evict oldest entry if at capacity
    if (this.#cache.size >= this.#maxCacheSize && !this.#cache.has(key)) {
      const firstKey = this.#cache.keys().next().value;
      if (firstKey !== undefined) this.#cache.delete(firstKey);
    }
    this.#cache.set(key, { state, expiresAt: Date.now() + ttl });
    // Fire-and-forget write to backing storage. The cache is authoritative for
    // reads, so a backing failure must not reject this call — but the rejection
    // must be caught, or it surfaces as an unhandledRejection that can crash
    // the process. Surface it via the optional callback instead.
    void Promise.resolve(this.#backing.setState(key, state, ttl)).catch((error) => {
      this.#onBackingError?.(error);
    });
  }

  async deleteState(key: string): Promise<void> {
    this.#cache.delete(key);
    return this.#backing.deleteState(key);
  }

  async hasState(key: string): Promise<boolean> {
    const cached = this.#cache.get(key);
    if (cached && Date.now() < cached.expiresAt) return true;
    return this.#backing.hasState(key);
  }

  async transaction<T>(key: string, cb: () => Promise<T>): Promise<T> {
    // Delegate locking to the backing store. The callback calls getState/setState
    // on *this* TieredRateLimitStorage instance (the rate limiter holds a single
    // `storage` reference), so reads/writes inside the transaction still benefit
    // from the cache layer.
    return this.#backing.transaction(key, cb);
  }
}
