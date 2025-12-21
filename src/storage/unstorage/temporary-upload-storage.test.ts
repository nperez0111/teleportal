import { describe, expect, it, beforeEach } from "bun:test";
import { createStorage } from "unstorage";
import { UnstorageTemporaryUploadStorage } from "./temporary-upload-storage";
import { CHUNK_SIZE } from "../../lib/merkle-tree/merkle-tree";

describe("UnstorageTemporaryUploadStorage", () => {
  let storage: UnstorageTemporaryUploadStorage;
  let unstorage: any;

  beforeEach(() => {
    unstorage = createStorage();
    storage = new UnstorageTemporaryUploadStorage(unstorage);
  });

  it("should initiate an upload", async () => {
    const fileId = "test-file-id";

    await storage.beginUpload(fileId, {
      filename: "test.txt",
      size: 1024,
      mimeType: "text/plain",
      encrypted: false,
      lastModified: Date.now(),
      documentId: "test-doc",
    });

    const progress = await storage.getUploadProgress(fileId);
    expect(progress).not.toBeNull();
    expect(progress!.metadata.filename).toBe("test.txt");
    expect(progress!.metadata.size).toBe(1024);
  });

  it("should store chunks and track progress", async () => {
    const fileId = "test-file-id";

    await storage.beginUpload(fileId, {
      filename: "test.txt",
      size: CHUNK_SIZE * 2,
      mimeType: "text/plain",
      encrypted: false,
      lastModified: Date.now(),
      documentId: "test-doc",
    });

    const chunk1 = new Uint8Array(CHUNK_SIZE);
    chunk1.fill(1);
    const proof1: Uint8Array[] = [];

    await storage.storeChunk(fileId, 0, chunk1, proof1);

    const progress = await storage.getUploadProgress(fileId);
    expect(progress!.bytesUploaded).toBe(CHUNK_SIZE);
    expect(progress!.chunks.has(0)).toBe(true);
  });

  it("should complete an upload and provide chunks", async () => {
    const fileId = "test-file-id";

    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])];

    await storage.beginUpload(fileId, {
      filename: "test.txt",
      size: chunks[0].length + chunks[1].length,
      mimeType: "text/plain",
      encrypted: false,
      lastModified: Date.now(),
      documentId: "test-doc",
    });

    for (let i = 0; i < chunks.length; i++) {
      await storage.storeChunk(fileId, i, chunks[i], []);
    }

    const { getChunk } = await storage.completeUpload(fileId, "any-id");

    const retrievedChunk0 = await getChunk(0);
    const retrievedChunk1 = await getChunk(1);

    expect(retrievedChunk0).toEqual(chunks[0]);
    expect(retrievedChunk1).toEqual(chunks[1]);
  });

  it("should cleanup expired uploads", async () => {
    const storageWithShortTimeout = new UnstorageTemporaryUploadStorage(
      unstorage,
      {
        uploadTimeoutMs: 100,
      },
    );

    const fileId = "test-file-id";
    await storageWithShortTimeout.beginUpload(fileId, {
      filename: "test.txt",
      size: 1024,
      mimeType: "text/plain",
      encrypted: false,
      lastModified: Date.now(),
      documentId: "test-doc",
    });

    await new Promise((resolve) => setTimeout(resolve, 150));

    await storageWithShortTimeout.cleanupExpiredUploads();

    const progress = await storageWithShortTimeout.getUploadProgress(fileId);
    expect(progress).toBeNull();
  });

  it("should persist data across storage instances", async () => {
    const fileId = "test-file-id";
    const storage1 = new UnstorageTemporaryUploadStorage(unstorage);

    await storage1.beginUpload(fileId, {
      filename: "test.txt",
      size: 1024,
      mimeType: "text/plain",
      encrypted: false,
      lastModified: Date.now(),
      documentId: "test-doc",
    });

    const storage2 = new UnstorageTemporaryUploadStorage(unstorage);
    const progress = await storage2.getUploadProgress(fileId);

    expect(progress).not.toBeNull();
    expect(progress!.metadata.filename).toBe("test.txt");
  });

  it("should use custom key prefix", async () => {
    const customStorage = new UnstorageTemporaryUploadStorage(unstorage, {
      keyPrefix: "custom",
    });

    const fileId = "test-file-id";
    await customStorage.beginUpload(fileId, {
      filename: "test.txt",
      size: 1024,
      mimeType: "text/plain",
      encrypted: false,
      lastModified: Date.now(),
      documentId: "test-doc",
    });

    const keys = await unstorage.getKeys("custom:");
    expect(keys.length).toBeGreaterThan(0);
    expect(keys[0]).toContain("custom:");
  });
});
