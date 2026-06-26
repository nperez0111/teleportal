export type WrappedKeyEntry = {
  userId: string;
  wrappedKey: Uint8Array;
};

export type KeyRegistryRecord = {
  wrappedKey: Uint8Array;
  generation: number;
};

export type KeyRegistryMeta = {
  generation: number;
  userIds: string[];
};

export interface KeyRegistryStorage {
  readonly type: "key-registry-storage";

  get(documentId: string, userId: string): Promise<KeyRegistryRecord | null>;

  getAny(documentId: string): Promise<(KeyRegistryRecord & { userId: string }) | null>;

  set(documentId: string, entries: WrappedKeyEntry[]): Promise<number>;

  revoke(documentId: string, userIds: string[]): Promise<number>;

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
}
