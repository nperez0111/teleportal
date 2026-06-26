import { beforeEach, describe, expect, it, mock } from "bun:test";

// ───────────────────────────────────────────────────────────────────────────
// In-memory mock of `lib0/indexeddb` — same approach as idb-storage.test.ts.
// ───────────────────────────────────────────────────────────────────────────

type Store = Map<string, unknown>;
const databases = new Map<string, Map<string, Store>>();

class FakeStore {
  constructor(
    public name: string,
    public data: Store,
  ) {}
  clear() {
    this.data.clear();
    return { cleared: true };
  }
}

mock.module("lib0/indexeddb", () => ({
  openDB: async (name: string, initDB: (db: any) => void) => {
    let stores = databases.get(name);
    if (!stores) {
      stores = new Map<string, Store>();
      databases.set(name, stores);
      initDB({
        createObjectStore: (storeName: string) => {
          stores!.set(storeName, new Map());
        },
        objectStoreNames: { contains: (n: string) => stores!.has(n) },
        close: () => {},
      });
    }
    return { __name: name, close: () => {} };
  },
  createStores: (db: any, defs: Array<Array<string>>) => {
    for (const def of defs) db.createObjectStore(def[0]);
  },
  transact: (db: any, names: string[]) => {
    const stores = databases.get(db.__name)!;
    return names.map((n) => new FakeStore(n, stores.get(n)!));
  },
  get: async (store: FakeStore, key: string) => store.data.get(key),
  put: async (store: FakeStore, item: unknown, key: string) => {
    store.data.set(key, item);
  },
  del: async (store: FakeStore, key: string) => {
    store.data.delete(key);
  },
  rtop: async (req: unknown) => req,
}));

const { IdbFileCache } = await import("./file-cache");

// ── Helpers ─────────────────────────────────────────────────────────────────

function storeSizes(dbName: string) {
  const stores = databases.get(dbName);
  return {
    files: stores?.get("files")?.size ?? 0,
    chunks: stores?.get("chunks")?.size ?? 0,
  };
}

function makeChunk(size: number, fill: number = 0xab): Uint8Array {
  const data = new Uint8Array(size);
  data.fill(fill);
  return data;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("IdbFileCache (mocked lib0/indexeddb)", () => {
  const DB_NAME = "test-file-cache";

  beforeEach(() => {
    databases.clear();
  });

  it("creates both object stores on first open", async () => {
    const cache = new IdbFileCache(DB_NAME);
    await cache.has("nonexistent");
    expect(Array.from(databases.get(DB_NAME)!.keys()).sort()).toEqual(["chunks", "files"]);
  });

  it("putMetadata + getMetadata round-trip", async () => {
    const cache = new IdbFileCache(DB_NAME);
    const metadata = {
      filename: "test.png",
      size: 128000,
      mimeType: "image/png",
      encrypted: true,
      totalChunks: 2,
      lastModified: 1234567890,
    };

    await cache.putMetadata("file-abc", metadata);
    const result = await cache.getMetadata("file-abc");
    expect(result).toEqual(metadata);
  });

  it("getMetadata returns null for unknown fileId", async () => {
    const cache = new IdbFileCache(DB_NAME);
    expect(await cache.getMetadata("unknown")).toBeNull();
  });

  it("putChunk + getChunk round-trip", async () => {
    const cache = new IdbFileCache(DB_NAME);
    const chunk = makeChunk(64 * 1024);

    await cache.putChunk("file-abc", 0, chunk);
    const result = await cache.getChunk("file-abc", 0);

    expect(result).not.toBeNull();
    expect(result!.length).toBe(chunk.length);
    expect(result!.every((b, i) => b === chunk[i])).toBe(true);
  });

  it("getChunk returns null for unknown chunk", async () => {
    const cache = new IdbFileCache(DB_NAME);
    expect(await cache.getChunk("unknown", 0)).toBeNull();
  });

  it("multi-chunk file round-trip", async () => {
    const cache = new IdbFileCache(DB_NAME);
    const chunks = [makeChunk(64 * 1024, 0x01), makeChunk(64 * 1024, 0x02), makeChunk(100, 0x03)];
    const metadata = {
      filename: "multi.bin",
      size: chunks.reduce((s, c) => s + c.length, 0),
      mimeType: "application/octet-stream",
      encrypted: false,
      totalChunks: 3,
      lastModified: Date.now(),
    };

    await cache.putMetadata("file-multi", metadata);
    for (let i = 0; i < chunks.length; i++) {
      await cache.putChunk("file-multi", i, chunks[i]);
    }

    expect(storeSizes(DB_NAME)).toEqual({ files: 1, chunks: 3 });

    const meta = await cache.getMetadata("file-multi");
    expect(meta).toEqual(metadata);

    for (let i = 0; i < chunks.length; i++) {
      const result = await cache.getChunk("file-multi", i);
      expect(result!.every((b, j) => b === chunks[i][j])).toBe(true);
    }
  });

  it("has returns true/false correctly", async () => {
    const cache = new IdbFileCache(DB_NAME);
    expect(await cache.has("file-abc")).toBe(false);

    await cache.putMetadata("file-abc", {
      filename: "test.txt",
      size: 100,
      mimeType: "text/plain",
      encrypted: false,
      totalChunks: 1,
      lastModified: Date.now(),
    });
    expect(await cache.has("file-abc")).toBe(true);
  });

  it("delete removes file metadata and all chunks", async () => {
    const cache = new IdbFileCache(DB_NAME);
    const metadata = {
      filename: "del.txt",
      size: 200,
      mimeType: "text/plain",
      encrypted: false,
      totalChunks: 2,
      lastModified: Date.now(),
    };

    await cache.putMetadata("file-del", metadata);
    await cache.putChunk("file-del", 0, makeChunk(100));
    await cache.putChunk("file-del", 1, makeChunk(100));
    expect(storeSizes(DB_NAME)).toEqual({ files: 1, chunks: 2 });

    await cache.delete("file-del");
    expect(storeSizes(DB_NAME)).toEqual({ files: 0, chunks: 0 });
    expect(await cache.has("file-del")).toBe(false);
    expect(await cache.getChunk("file-del", 0)).toBeNull();
  });

  it("delete is a no-op for unknown fileId", async () => {
    const cache = new IdbFileCache(DB_NAME);
    await cache.delete("nonexistent"); // should not throw
  });

  it("clear removes all files and chunks", async () => {
    const cache = new IdbFileCache(DB_NAME);

    await cache.putMetadata("file-1", {
      filename: "a.txt",
      size: 100,
      mimeType: "text/plain",
      encrypted: false,
      totalChunks: 1,
      lastModified: Date.now(),
    });
    await cache.putChunk("file-1", 0, makeChunk(100));
    await cache.putMetadata("file-2", {
      filename: "b.txt",
      size: 200,
      mimeType: "text/plain",
      encrypted: false,
      totalChunks: 1,
      lastModified: Date.now(),
    });
    await cache.putChunk("file-2", 0, makeChunk(200));

    expect(storeSizes(DB_NAME)).toEqual({ files: 2, chunks: 2 });

    await cache.clear();
    expect(storeSizes(DB_NAME)).toEqual({ files: 0, chunks: 0 });
  });

  it("overwriting an existing file replaces metadata and chunks", async () => {
    const cache = new IdbFileCache(DB_NAME);

    await cache.putMetadata("file-ow", {
      filename: "v1.txt",
      size: 100,
      mimeType: "text/plain",
      encrypted: false,
      totalChunks: 1,
      lastModified: 1000,
    });
    await cache.putChunk("file-ow", 0, makeChunk(100, 0x01));

    await cache.putMetadata("file-ow", {
      filename: "v2.txt",
      size: 200,
      mimeType: "text/plain",
      encrypted: false,
      totalChunks: 1,
      lastModified: 2000,
    });
    await cache.putChunk("file-ow", 0, makeChunk(200, 0x02));

    const meta = await cache.getMetadata("file-ow");
    expect(meta!.filename).toBe("v2.txt");
    expect(meta!.size).toBe(200);

    const chunk = await cache.getChunk("file-ow", 0);
    expect(chunk!.length).toBe(200);
    expect(chunk![0]).toBe(0x02);
  });

  it("persists across cache instances (simulated reload)", async () => {
    const cache1 = new IdbFileCache(DB_NAME);
    await cache1.putMetadata("file-persist", {
      filename: "durable.txt",
      size: 50,
      mimeType: "text/plain",
      encrypted: false,
      totalChunks: 1,
      lastModified: Date.now(),
    });
    await cache1.putChunk("file-persist", 0, makeChunk(50));
    cache1.close();

    const cache2 = new IdbFileCache(DB_NAME);
    expect(await cache2.has("file-persist")).toBe(true);
    const meta = await cache2.getMetadata("file-persist");
    expect(meta!.filename).toBe("durable.txt");
    const chunk = await cache2.getChunk("file-persist", 0);
    expect(chunk!.length).toBe(50);
  });
});
