import { describe, expect, it } from "bun:test";
import { CHUNK_SIZE } from "../../lib/merkle-tree/merkle-tree";
import { InMemoryTemporaryUploadStorage } from "./temporary-upload-storage";

describe("InMemoryTemporaryUploadStorage", () => {
  it("should initiate an upload", async () => {
    const storage = new InMemoryTemporaryUploadStorage();
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
    const storage = new InMemoryTemporaryUploadStorage();
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
    const storage = new InMemoryTemporaryUploadStorage();
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

    // Store chunks
    for (let i = 0; i < chunks.length; i++) {
      await storage.storeChunk(fileId, i, chunks[i], []);
    }

    // Complete upload
    const { getChunk } = await storage.completeUpload(fileId, "any-id");

    const retrievedChunk0 = await getChunk(0);
    const retrievedChunk1 = await getChunk(1);

    expect(retrievedChunk0).toEqual(chunks[0]);
    expect(retrievedChunk1).toEqual(chunks[1]);
  });

  it("should cleanup expired uploads", async () => {
    const storage = new InMemoryTemporaryUploadStorage({
      uploadTimeoutMs: 100,
    });

    const fileId = "test-file-id";
    await storage.beginUpload(fileId, {
      filename: "test.txt",
      size: 1024,
      mimeType: "text/plain",
      encrypted: false,
      lastModified: Date.now(),
      documentId: "test-doc",
    });

    // Wait for expiration
    await new Promise((resolve) => setTimeout(resolve, 150));

    await storage.cleanupExpiredUploads();

    const progress = await storage.getUploadProgress(fileId);
    expect(progress).toBeNull();
  });
});
