/**
 * Minimal structural types for the Cloudflare Workers APIs this package
 * touches. Kept local so the library does not depend on
 * `@cloudflare/workers-types`, whose ambient globals conflict with
 * `@types/bun` in this repo's typecheck. Real Cloudflare objects satisfy
 * these shapes structurally.
 */

export type DurableObjectListOptions = {
  prefix?: string;
  start?: string;
  startAfter?: string;
  end?: string;
  limit?: number;
  reverse?: boolean;
};

/**
 * The subset of `DurableObjectStorage` (the `ctx.storage` of a Durable
 * Object) that the `DurableObject*Storage` implementations use. Values are
 * structured-clonable, so `Uint8Array`s round-trip natively.
 */
export interface DurableObjectStorageLike {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  delete(keys: string[]): Promise<number>;
  list<T = unknown>(options?: DurableObjectListOptions): Promise<Map<string, T>>;
  deleteAll(): Promise<void>;
}

/**
 * The subset of `DurableObjectState` a Teleportal Durable Object needs.
 */
export interface DurableObjectStateLike {
  storage: DurableObjectStorageLike;
  acceptWebSocket(ws: unknown, tags?: string[]): void;
  getWebSockets(tag?: string): unknown[];
}

/**
 * Cloudflare's bulk `delete()` accepts at most this many keys per call.
 */
export const MAX_KEYS_PER_DELETE = 128;

/**
 * Page size used when listing keys; `list()` calls are repeated with
 * `startAfter` until a short page signals the end.
 */
export const LIST_PAGE_SIZE = 1000;

/**
 * Collect every entry under `prefix`, paginating with `startAfter`.
 * (Durable Object `list()` always returns values along with keys.)
 */
export async function listAll<T = unknown>(
  storage: DurableObjectStorageLike,
  prefix: string,
): Promise<Map<string, T>> {
  const entries = new Map<string, T>();
  let startAfter: string | undefined;
  for (;;) {
    const page = await storage.list<T>({ prefix, startAfter, limit: LIST_PAGE_SIZE });
    for (const [key, value] of page) {
      entries.set(key, value);
      startAfter = key;
    }
    if (page.size < LIST_PAGE_SIZE) {
      return entries;
    }
  }
}

/**
 * Collect every key under `prefix`, paginating with `startAfter`.
 */
export async function listAllKeys(
  storage: DurableObjectStorageLike,
  prefix: string,
): Promise<string[]> {
  return [...(await listAll(storage, prefix)).keys()];
}

/**
 * Delete keys in batches of {@link MAX_KEYS_PER_DELETE}.
 */
export async function deleteKeys(storage: DurableObjectStorageLike, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += MAX_KEYS_PER_DELETE) {
    await storage.delete(keys.slice(i, i + MAX_KEYS_PER_DELETE));
  }
}

/**
 * Per-key mutual exclusion via promise chaining.
 *
 * A Durable Object instance is the single writer for its storage, so an
 * in-memory mutex is sufficient for the `transaction()` contract of the
 * storage interfaces — no TTL locks or advisory locks needed. It only has to
 * prevent interleaving between concurrent requests inside the same instance
 * (Durable Objects interleave requests at await points that leave storage,
 * e.g. crypto calls).
 */
export class KeyedMutex {
  #tails = new Map<string, Promise<void>>();

  async run<T>(key: string, cb: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const result = previous.then(cb);
    // The stored tail must never reject, or every later waiter would throw.
    const tail = result.then(
      () => {},
      () => {},
    );
    this.#tails.set(key, tail);
    void tail.then(() => {
      if (this.#tails.get(key) === tail) {
        this.#tails.delete(key);
      }
    });
    return result;
  }
}
