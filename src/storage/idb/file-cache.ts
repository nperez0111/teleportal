import * as idb from "lib0/indexeddb";

const FILES_STORE = "files";
const CHUNKS_STORE = "chunks";

export interface CachedFileMetadata {
  filename: string;
  size: number;
  mimeType: string;
  encrypted: boolean;
  totalChunks: number;
  lastModified: number;
}

export interface FileCache {
  getMetadata(fileId: string): Promise<CachedFileMetadata | null>;
  getChunk(fileId: string, chunkIndex: number): Promise<Uint8Array | null>;
  putMetadata(fileId: string, metadata: CachedFileMetadata): Promise<void>;
  putChunk(fileId: string, chunkIndex: number, data: Uint8Array): Promise<void>;
  delete(fileId: string): Promise<void>;
  has(fileId: string): Promise<boolean>;
  clear(): Promise<void>;
  close(): void;
}

export class IdbFileCache implements FileCache {
  #db: IDBDatabase | null = null;
  #dbPromise: Promise<IDBDatabase> | null = null;
  readonly #dbName: string;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(dbName: string = "teleportal-file-cache") {
    this.#dbName = dbName;
  }

  #run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(fn, fn);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #open(): Promise<IDBDatabase> {
    if (this.#db) return this.#db;
    if (this.#dbPromise) return this.#dbPromise;
    this.#dbPromise = idb.openDB(this.#dbName, (db: IDBDatabase) => {
      idb.createStores(db, [[FILES_STORE], [CHUNKS_STORE]]);
    });
    this.#db = await this.#dbPromise;
    this.#dbPromise = null;
    return this.#db;
  }

  #getStore(name: string, mode: "readonly" | "readwrite" = "readonly"): IDBObjectStore {
    const db = this.#db;
    if (!db) throw new Error("IdbFileCache: database not open");
    const [store] = idb.transact(db, [name], mode);
    return store;
  }

  async getMetadata(fileId: string): Promise<CachedFileMetadata | null> {
    return this.#run(async () => {
      await this.#open();
      const store = this.#getStore(FILES_STORE);
      const raw = (await idb.get(store, fileId)) as unknown as string | undefined;
      if (!raw) return null;
      return JSON.parse(raw) as CachedFileMetadata;
    });
  }

  async getChunk(fileId: string, chunkIndex: number): Promise<Uint8Array | null> {
    return this.#run(async () => {
      await this.#open();
      const store = this.#getStore(CHUNKS_STORE);
      const raw = (await idb.get(store, `${fileId}:${chunkIndex}`)) as unknown as
        | ArrayBuffer
        | undefined;
      return raw ? new Uint8Array(raw) : null;
    });
  }

  async putMetadata(fileId: string, metadata: CachedFileMetadata): Promise<void> {
    return this.#run(async () => {
      await this.#open();
      const store = this.#getStore(FILES_STORE, "readwrite");
      await idb.put(store, JSON.stringify(metadata), fileId);
    });
  }

  async putChunk(fileId: string, chunkIndex: number, data: Uint8Array): Promise<void> {
    return this.#run(async () => {
      await this.#open();
      const store = this.#getStore(CHUNKS_STORE, "readwrite");
      await idb.put(
        store,
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
        `${fileId}:${chunkIndex}`,
      );
    });
  }

  async delete(fileId: string): Promise<void> {
    return this.#run(async () => {
      await this.#open();
      const filesStore = this.#getStore(FILES_STORE, "readwrite");
      const raw = (await idb.get(filesStore, fileId)) as unknown as string | undefined;
      if (!raw) return;

      const metadata = JSON.parse(raw) as CachedFileMetadata;
      await idb.del(filesStore, fileId);

      const chunksStore = this.#getStore(CHUNKS_STORE, "readwrite");
      for (let i = 0; i < metadata.totalChunks; i++) {
        await idb.del(chunksStore, `${fileId}:${i}`);
      }
    });
  }

  async has(fileId: string): Promise<boolean> {
    return this.#run(async () => {
      await this.#open();
      const store = this.#getStore(FILES_STORE);
      const raw = await idb.get(store, fileId);
      return raw !== undefined;
    });
  }

  async clear(): Promise<void> {
    return this.#run(async () => {
      await this.#open();
      const filesStore = this.#getStore(FILES_STORE, "readwrite");
      const chunksStore = this.#getStore(CHUNKS_STORE, "readwrite");
      await idb.rtop(filesStore.clear());
      await idb.rtop(chunksStore.clear());
    });
  }

  close(): void {
    if (this.#db) {
      this.#db.close();
      this.#db = null;
    }
  }
}
