import { describe, expect, it } from "bun:test";
import { S3Http, type S3HeadResult, type S3ObjectInfo } from "./client";
import { S3TemporaryUploadStorage } from "./temporary-upload-storage";
import type { FileMetadata } from "teleportal/storage";

/**
 * In-memory stand-in for {@link S3Http} that records how many times `listAll`
 * is invoked. `S3TemporaryUploadStorage` accepts any `S3Http` instance, and it
 * only ever touches the five methods overridden below, so no real endpoint (or
 * MinIO) is needed.
 */
class FakeS3 extends S3Http {
  listAllCalls = 0;
  #store = new Map<string, { body: Uint8Array; meta: Record<string, string>; lastModified: number }>();
  #clock = 1;

  constructor() {
    super({
      endpoint: "http://localhost:9000",
      bucket: "test-bucket",
      region: "us-east-1",
      accessKeyId: "x",
      secretAccessKey: "y",
    });
  }

  async putObject(
    key: string,
    body: Uint8Array,
    options: { contentType?: string; meta?: Record<string, string> } = {},
  ): Promise<void> {
    this.#store.set(key, {
      body: body.slice(),
      meta: { ...options.meta },
      lastModified: this.#clock++,
    });
  }

  async getObject(key: string): Promise<Uint8Array | null> {
    return this.#store.get(key)?.body ?? null;
  }

  async headObject(key: string): Promise<S3HeadResult | null> {
    const o = this.#store.get(key);
    if (!o) return null;
    return { size: o.body.length, lastModified: o.lastModified, meta: o.meta };
  }

  async listAll(prefix: string): Promise<{ objects: S3ObjectInfo[]; commonPrefixes: string[] }> {
    this.listAllCalls++;
    const objects: S3ObjectInfo[] = [];
    for (const [key, o] of this.#store) {
      if (key.startsWith(prefix)) {
        objects.push({ key, size: o.body.length, lastModified: o.lastModified });
      }
    }
    return { objects, commonPrefixes: [] };
  }

  async deleteObjects(keys: readonly string[]): Promise<void> {
    for (const k of keys) this.#store.delete(k);
  }
}

function metadata(size: number): FileMetadata {
  return {
    filename: "test.bin",
    size,
    mimeType: "application/octet-stream",
    encrypted: false,
    lastModified: 1,
    documentId: "doc-1",
  };
}

function chunk(byte: number, size = 8): Uint8Array {
  return new Uint8Array(size).fill(byte);
}

describe("S3TemporaryUploadStorage chunk counting", () => {
  it("does not LIST per stored chunk (was O(N^2))", async () => {
    const s3 = new FakeS3();
    const temp = new S3TemporaryUploadStorage(s3);
    const uploadId = "upload-a";

    const n = 6;
    await temp.beginUpload(uploadId, metadata(n * 8));

    let last = 0;
    for (let i = 0; i < n; i++) {
      const { storedChunks } = await temp.storeChunk(uploadId, i, chunk(i), []);
      last = storedChunks;
    }

    expect(last).toBe(n);
    // Before the fix, every storeChunk did a full listAll → N calls. Now the
    // count is seeded once (an empty session seeds to 0) and incremented in
    // memory, so the number of LISTs is constant regardless of chunk count.
    expect(s3.listAllCalls).toBeLessThanOrEqual(1);
  });

  it("counts out-of-order chunks and never double-counts a retransmit", async () => {
    const s3 = new FakeS3();
    const temp = new S3TemporaryUploadStorage(s3);
    const uploadId = "upload-b";
    await temp.beginUpload(uploadId, metadata(24));

    expect((await temp.storeChunk(uploadId, 5, chunk(5), [])).storedChunks).toBe(1);
    expect((await temp.storeChunk(uploadId, 2, chunk(2), [])).storedChunks).toBe(2);
    // Identical retransmit of an already-stored chunk must not grow the count.
    expect((await temp.storeChunk(uploadId, 5, chunk(5), [])).storedChunks).toBe(2);
    // A genuinely new chunk still increments.
    expect((await temp.storeChunk(uploadId, 0, chunk(0), [])).storedChunks).toBe(3);
  });

  it("rejects a conflicting overwrite of a stored chunk", async () => {
    const s3 = new FakeS3();
    const temp = new S3TemporaryUploadStorage(s3);
    const uploadId = "upload-c";
    await temp.beginUpload(uploadId, metadata(8));

    await temp.storeChunk(uploadId, 0, chunk(1), []);
    await expect(temp.storeChunk(uploadId, 0, chunk(9), [])).rejects.toThrow(/conflict/i);
  });

  it("seeds the count from storage for a session resumed on a fresh instance", async () => {
    const s3 = new FakeS3();
    const uploadId = "upload-d";

    const first = new S3TemporaryUploadStorage(s3);
    await first.beginUpload(uploadId, metadata(24));
    await first.storeChunk(uploadId, 0, chunk(0), []);
    await first.storeChunk(uploadId, 1, chunk(1), []);

    // A second instance (e.g. a different server) shares the same bucket but
    // has an empty in-memory counter; it must seed from a LIST so it does not
    // undercount the two chunks already persisted.
    const second = new S3TemporaryUploadStorage(s3);
    const { storedChunks } = await second.storeChunk(uploadId, 2, chunk(2), []);
    expect(storedChunks).toBe(3);
  });
});
