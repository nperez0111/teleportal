import { beforeEach, describe, expect, it } from "bun:test";
import { toBase64 } from "teleportal/utils";
import { buildMerkleTree, CHUNK_SIZE } from "teleportal/merkle-tree";

import { FakeDOStorage } from "./fake-do-storage";
import { DurableObjectFileStorage, DurableObjectTemporaryUploadStorage } from "./file-storage";

describe("DurableObjectFileStorage", () => {
  let fake: FakeDOStorage;
  let storage: DurableObjectFileStorage;
  let temp: DurableObjectTemporaryUploadStorage;

  const beginTestUpload = (uploadId: string, size: number) =>
    temp.beginUpload(uploadId, {
      filename: "test.txt",
      size,
      mimeType: "text/plain",
      encrypted: false,
      lastModified: Date.now(),
      documentId: "test-doc",
    });

  beforeEach(() => {
    fake = new FakeDOStorage();
    temp = new DurableObjectTemporaryUploadStorage(fake);
    storage = new DurableObjectFileStorage(fake, { temporaryUploadStorage: temp });
  });

  it("stores completed files and can retrieve them", async () => {
    const uploadId = "test-upload-id";
    const chunks = [new Uint8Array([1, 2, 3, 4, 5, 6])];
    const contentId = (await buildMerkleTree(chunks)).nodes.at(-1)!.hash!;
    const fileId = toBase64(contentId);

    await beginTestUpload(uploadId, chunks[0].length);
    for (const [i, chunk] of chunks.entries()) {
      await temp.storeChunk(uploadId, i, chunk, []);
    }

    const result = await temp.completeUpload(uploadId, chunks.length, fileId);
    await storage.storeFileFromUpload(result);

    const file = await storage.getFile(result.fileId);
    expect(file).not.toBeNull();
    expect(file!.id).toBe(fileId);
    expect(file!.metadata.filename).toBe("test.txt");
    expect(file!.chunks.length).toBe(1);
    expect(file!.chunks[0]).toEqual(chunks[0]);
    expect(file!.contentId).toEqual(contentId);
    expect(file!.serializedMerkleTree).toEqual(result.serializedMerkleTree);
  });

  it("tracks upload progress and chunk completion", async () => {
    const uploadId = "test-upload-id";
    const chunks = [new Uint8Array(CHUNK_SIZE), new Uint8Array(CHUNK_SIZE)];
    chunks[0].fill(1);
    chunks[1].fill(2);

    await beginTestUpload(uploadId, CHUNK_SIZE * 2);

    await temp.storeChunk(uploadId, 0, chunks[0], []);
    const progress = await temp.getUploadProgress(uploadId);
    expect(progress).not.toBeNull();
    expect(progress!.chunks.get(0)).toBe(true);
    expect(progress!.chunks.get(1)).toBe(undefined);
    expect(progress!.bytesUploaded).toBe(CHUNK_SIZE);

    await temp.storeChunk(uploadId, 1, chunks[1], []);
    await temp.completeUpload(uploadId, chunks.length);
  });

  it("is idempotent on chunk retransmits and rejects conflicting bytes", async () => {
    const uploadId = "test-upload-id";
    const chunk = new Uint8Array([1, 2, 3]);

    await beginTestUpload(uploadId, chunk.length);

    expect(await temp.storeChunk(uploadId, 0, chunk, [])).toEqual({ storedChunks: 1 });
    // Identical retransmit is harmless and does not double-count.
    expect(await temp.storeChunk(uploadId, 0, chunk, [])).toEqual({ storedChunks: 1 });
    // Different bytes for a stored chunk are poisoning — refuse.
    await expect(temp.storeChunk(uploadId, 0, new Uint8Array([9, 9, 9]), [])).rejects.toThrow(
      "conflicts with already-stored data",
    );
  });

  it("cleans up expired uploads", async () => {
    temp = new DurableObjectTemporaryUploadStorage(fake, { uploadTimeoutMs: 1 });

    const uploadId = "test-upload-id";
    await beginTestUpload(uploadId, 1024);
    await temp.storeChunk(uploadId, 0, new Uint8Array([1]), []);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await temp.cleanupExpiredUploads();

    expect(await temp.getUploadProgress(uploadId)).toBeNull();
    expect(fake.size).toBe(0);
  });

  it("keeps chunks fetchable via getChunk and cleans up only on deleteUpload", async () => {
    const uploadId = "test-upload-id";
    const chunks = [new Uint8Array(CHUNK_SIZE).fill(1), new Uint8Array([2])];
    const fileId = toBase64((await buildMerkleTree(chunks)).nodes.at(-1)!.hash!);

    await beginTestUpload(uploadId, chunks[0].length + chunks[1].length);
    for (const [i, chunk] of chunks.entries()) {
      await temp.storeChunk(uploadId, i, chunk, []);
    }

    const result = await temp.completeUpload(uploadId, chunks.length, fileId);

    // Fetch all chunks via getChunk — this does not delete them.
    expect(await result.getChunk(0)).toEqual(chunks[0]);
    expect(await result.getChunk(1)).toEqual(chunks[1]);
    // Re-fetching is idempotent (retriable store).
    expect(await result.getChunk(0)).toEqual(chunks[0]);

    // Chunks and session persist until deleteUpload.
    expect(await temp.getUploadProgress(uploadId)).not.toBeNull();

    await temp.deleteUpload(uploadId);

    expect(await temp.getUploadProgress(uploadId)).toBeNull();
    expect(fake.size).toBe(0);
  });

  it("persists the file durably while temp chunks are cleaned up", async () => {
    const uploadId = "test-upload-id";
    const chunks = [new Uint8Array([1, 2, 3, 4, 5, 6])];
    const fileId = toBase64((await buildMerkleTree(chunks)).nodes.at(-1)!.hash!);

    await beginTestUpload(uploadId, chunks[0].length);
    await temp.storeChunk(uploadId, 0, chunks[0], []);
    const result = await temp.completeUpload(uploadId, chunks.length, fileId);

    await storage.storeFileFromUpload(result);
    await temp.deleteUpload(uploadId);

    const file = await storage.getFile(result.fileId);
    expect(file).not.toBeNull();
    expect(file!.chunks[0]).toEqual(chunks[0]);

    // No temp keys remain — only the durable manifest + chunk.
    expect((await fake.list({ prefix: "file:upload-" })).size).toBe(0);
    expect((await fake.list({ prefix: "file:file-" })).size).toBe(2);
  });

  it("rejects completion when chunks are missing", async () => {
    const uploadId = "test-upload-id";
    await beginTestUpload(uploadId, 10);
    await temp.storeChunk(uploadId, 1, new Uint8Array([1]), []);

    await expect(temp.completeUpload(uploadId, 2)).rejects.toThrow("Missing chunk 0");
  });

  it("rejects completion on merkle root mismatch", async () => {
    const uploadId = "test-upload-id";
    await beginTestUpload(uploadId, 3);
    await temp.storeChunk(uploadId, 0, new Uint8Array([1, 2, 3]), []);

    await expect(temp.completeUpload(uploadId, 1, "not-the-root")).rejects.toThrow(
      "Merkle root mismatch",
    );
  });

  describe("deleteFile", () => {
    it("deletes the manifest and all chunks", async () => {
      const uploadId = "test-upload-id";
      const chunks = [new Uint8Array([1, 2, 3, 4, 5, 6])];
      const fileId = toBase64((await buildMerkleTree(chunks)).nodes.at(-1)!.hash!);

      await beginTestUpload(uploadId, chunks[0].length);
      await temp.storeChunk(uploadId, 0, chunks[0], []);
      const result = await temp.completeUpload(uploadId, chunks.length, fileId);
      await storage.storeFileFromUpload(result);
      await temp.deleteUpload(uploadId);

      expect(await storage.getFile(fileId)).not.toBeNull();

      await storage.deleteFile(fileId);

      expect(await storage.getFile(fileId)).toBeNull();
      expect(fake.size).toBe(0);
    });
  });
});
