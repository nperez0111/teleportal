import { type DurableObjectListOptions, MAX_KEYS_PER_DELETE } from "./types";

/**
 * In-memory stand-in for Durable Object storage used by the test suites.
 *
 * Mirrors the semantics that matter for correctness: values round-trip
 * through structured clone (so tests fail on non-clonable values), `list()`
 * returns entries in UTF-8 key order with prefix/startAfter/limit/reverse
 * honored, and bulk `delete()` rejects more than 128 keys per call like the
 * real API.
 */
export class FakeDOStorage {
  #map = new Map<string, unknown>();

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const value = this.#map.get(key);
    return value === undefined ? undefined : (structuredClone(value) as T);
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.#map.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<boolean>;
  async delete(keys: string[]): Promise<number>;
  async delete(keyOrKeys: string | string[]): Promise<boolean | number> {
    if (Array.isArray(keyOrKeys)) {
      if (keyOrKeys.length > MAX_KEYS_PER_DELETE) {
        throw new Error(`delete() supports at most ${MAX_KEYS_PER_DELETE} keys`);
      }
      let deleted = 0;
      for (const key of keyOrKeys) {
        if (this.#map.delete(key)) deleted++;
      }
      return deleted;
    }
    return this.#map.delete(keyOrKeys);
  }

  async list<T = unknown>(options?: DurableObjectListOptions): Promise<Map<string, T>> {
    let keys = [...this.#map.keys()].sort();
    if (options?.prefix !== undefined) {
      keys = keys.filter((key) => key.startsWith(options.prefix!));
    }
    if (options?.start !== undefined) {
      keys = keys.filter((key) => key >= options.start!);
    }
    if (options?.startAfter !== undefined) {
      keys = keys.filter((key) => key > options.startAfter!);
    }
    if (options?.end !== undefined) {
      keys = keys.filter((key) => key < options.end!);
    }
    if (options?.reverse) {
      keys.reverse();
    }
    if (options?.limit !== undefined) {
      keys = keys.slice(0, options.limit);
    }
    return new Map(keys.map((key) => [key, structuredClone(this.#map.get(key)) as T]));
  }

  async deleteAll(): Promise<void> {
    this.#map.clear();
  }

  /** Number of stored keys — test-only convenience. */
  get size(): number {
    return this.#map.size;
  }
}
