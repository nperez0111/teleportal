import type {
  KeyRegistryStorage,
  KeyRegistryRecord,
  KeyRegistryMeta,
  WrappedKeyEntry,
} from "../../protocols/key-registry/storage";

type DocumentKeyState = {
  generation: number;
  keys: Map<string, Uint8Array>;
};

export class InMemoryKeyRegistryStorage implements KeyRegistryStorage {
  readonly type = "key-registry-storage" as const;

  #docs = new Map<string, DocumentKeyState>();

  #getOrCreate(documentId: string): DocumentKeyState {
    let state = this.#docs.get(documentId);
    if (!state) {
      state = { generation: 0, keys: new Map() };
      this.#docs.set(documentId, state);
    }
    return state;
  }

  async get(documentId: string, userId: string): Promise<KeyRegistryRecord | null> {
    const state = this.#docs.get(documentId);
    if (!state) return null;
    const wrappedKey = state.keys.get(userId);
    if (!wrappedKey) return null;
    return { wrappedKey, generation: state.generation };
  }

  async getAny(documentId: string): Promise<(KeyRegistryRecord & { userId: string }) | null> {
    const state = this.#docs.get(documentId);
    if (!state || state.keys.size === 0) return null;
    const [userId, wrappedKey] = state.keys.entries().next().value!;
    return { userId, wrappedKey, generation: state.generation };
  }

  async set(documentId: string, entries: WrappedKeyEntry[]): Promise<number> {
    const state = this.#getOrCreate(documentId);
    for (const { userId, wrappedKey } of entries) {
      state.keys.set(userId, wrappedKey);
    }
    return state.generation;
  }

  async revoke(documentId: string, userIds: string[]): Promise<number> {
    const state = this.#docs.get(documentId);
    if (!state) return 0;
    for (const userId of userIds) {
      state.keys.delete(userId);
    }
    return state.generation;
  }

  async getMeta(documentId: string): Promise<KeyRegistryMeta> {
    const state = this.#docs.get(documentId);
    if (!state) return { generation: 0, userIds: [] };
    return {
      generation: state.generation,
      userIds: [...state.keys.keys()],
    };
  }

  async rotate(
    documentId: string,
    entries: WrappedKeyEntry[],
    expectedGeneration: number,
  ): Promise<number> {
    const state = this.#getOrCreate(documentId);
    if (state.generation !== expectedGeneration) {
      throw new Error(
        `Key rotation conflict: expected generation ${expectedGeneration}, ` +
          `but current is ${state.generation}`,
      );
    }
    state.keys.clear();
    for (const { userId, wrappedKey } of entries) {
      state.keys.set(userId, wrappedKey);
    }
    state.generation++;
    return state.generation;
  }

  transaction<T>(_documentId: string, cb: () => Promise<T>): Promise<T> {
    return cb();
  }
}
