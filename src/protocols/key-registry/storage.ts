/** A user's wrapped (encrypted) document key, ready for storage. */
export type WrappedKeyEntry = {
  userId: string;
  wrappedKey: Uint8Array;
};

/** A stored wrapped key together with the document's current key generation. */
export type KeyRegistryRecord = {
  wrappedKey: Uint8Array;
  generation: number;
};

/** Summary of a document's key state: the current generation and which users hold a key. */
export type KeyRegistryMeta = {
  generation: number;
  userIds: string[];
};

/**
 * Persistent store for per-document, per-user wrapped encryption keys.
 *
 * The server never sees plaintext document keys — only opaque wrapped blobs.
 * Each document tracks a monotonic `generation` counter that increments on
 * every {@link rotate} call, enabling optimistic concurrency control.
 */
export interface KeyRegistryStorage {
  readonly type: "key-registry-storage";

  /** Retrieve a specific user's wrapped key for a document, or `null` if none exists. */
  get(documentId: string, userId: string): Promise<KeyRegistryRecord | null>;

  /** Retrieve any single user's wrapped key for a document (useful for re-wrapping during grant). */
  getAny(documentId: string): Promise<(KeyRegistryRecord & { userId: string }) | null>;

  /** Store (or overwrite) wrapped keys for one or more users. Returns the current generation. */
  set(documentId: string, entries: WrappedKeyEntry[]): Promise<number>;

  /** Remove the wrapped keys for the given users. Returns the current generation. */
  revoke(documentId: string, userIds: string[]): Promise<number>;

  /** Return the current generation and list of user IDs that hold a key. */
  getMeta(documentId: string): Promise<KeyRegistryMeta>;

  /**
   * Atomically replace all wrapped keys and bump the generation.
   * Throws if `expectedGeneration` doesn't match the current generation
   * (optimistic concurrency).
   */
  rotate(
    documentId: string,
    entries: WrappedKeyEntry[],
    expectedGeneration: number,
  ): Promise<number>;

  /** Execute `cb` inside a storage-level transaction scoped to `documentId`. */
  transaction<T>(documentId: string, cb: () => Promise<T>): Promise<T>;
}
