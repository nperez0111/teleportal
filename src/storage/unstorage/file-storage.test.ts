import { beforeEach, describe, expect, it } from "bun:test";
import { toBase64 } from "teleportal/utils";
import { buildMerkleTree, CHUNK_SIZE } from "teleportal/merkle-tree";
import { createStorage } from "unstorage";
import { UnstorageFileStorage } from "./file-storage";
import { UnstorageTemporaryUploadStorage } from "./temporary-upload-storage";

describe("UnstorageFileStorage", () => {
  let storage: UnstorageFileStorage;
  let temp: UnstorageTemporaryUploadStorage;

  beforeEach(() => {
    const unstorage = createStorage();
    storage = new UnstorageFileStorage(unstorage);
    temp = new UnstorageTemporaryUploadStorage(unstorage);
    storage.temporaryUploadStorage = temp;
  });

  it("stores completed files and can retrieve them", async () => {
    const uploadId = "test-upload-id";
    // For a small file (6 bytes), it should be a single chunk
    const chunks = [new Uint8Array([1, 2, 3, 4, 5, 6])];
    const contentId = (await buildMerkleTree(chunks)).nodes.at(-1)!.hash!;
    const fileId = toBase64(contentId);

    await temp.beginUpload(uploadId, {
      filename: "test.txt",
      size: chunks[0].length,
      mimeType: "text/plain",
      encrypted: false,
      lastModified: Date.now(),
      documentId: "test-doc",
    });

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
  });

  it("tracks upload progress and chunk completion", async () => {
    const uploadId = "test-upload-id";
    const chunks = [new Uint8Array(CHUNK_SIZE), new Uint8Array(CHUNK_SIZE)];
    chunks[0].fill(1);
    chunks[1].fill(2);
    const _fileId = toBase64((await buildMerkleTree(chunks)).nodes.at(-1)!.hash!);

    await temp.beginUpload(uploadId, {
      filename: "test.txt",
      size: CHUNK_SIZE * 2,
      mimeType: "text/plain",
      encrypted: false,
      lastModified: Date.now(),
      documentId: "test-doc",
    });

    await temp.storeChunk(uploadId, 0, chunks[0], []);
    const progress = await temp.getUploadProgress(uploadId);
    expect(progress).not.toBeNull();
    expect(progress!.chunks.get(0)).toBe(true);
    expect(progress!.chunks.get(1)).toBe(undefined);
    expect(progress!.bytesUploaded).toBe(CHUNK_SIZE);

    await temp.storeChunk(uploadId, 1, chunks[1], []);
    await temp.completeUpload(uploadId, chunks.length);
  });

  it("cleans up expired uploads", async () => {
    const unstorage = createStorage();
    storage = new UnstorageFileStorage(unstorage);
    temp = new UnstorageTemporaryUploadStorage(unstorage, {
      uploadTimeoutMs: 1,
    });
    storage.temporaryUploadStorage = temp;

    const uploadId = "test-upload-id";
    await temp.beginUpload(uploadId, {
      filename: "test.txt",
      size: 1024,
      mimeType: "text/plain",
      encrypted: false,
      lastModified: Date.now(),
      documentId: "test-doc",
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    await temp.cleanupExpiredUploads();

    const progress = await temp.getUploadProgress(uploadId);
    expect(progress).toBeNull();
  });

  it("should cleanup upload session and chunks after all chunks are fetched via getChunk", async () => {
    const unstorage = createStorage();
    storage = new UnstorageFileStorage(unstorage);
    temp = new UnstorageTemporaryUploadStorage(unstorage);
    storage.temporaryUploadStorage = temp;

    const uploadId = "test-upload-id";
    // Create a file that requires 2 chunks (CHUNK_SIZE + 1 byte)
    const chunks = [new Uint8Array(CHUNK_SIZE).fill(1), new Uint8Array([2])];
    const fileId = toBase64((await buildMerkleTree(chunks)).nodes.at(-1)!.hash!);

    await temp.beginUpload(uploadId, {
      filename: "test.txt",
      size: chunks[0].length + chunks[1].length,
      mimeType: "text/plain",
      encrypted: false,
      lastModified: Date.now(),
      documentId: "test-doc",
    });

    for (const [i, chunk] of chunks.entries()) {
      await temp.storeChunk(uploadId, i, chunk, []);
    }

    const result = await temp.completeUpload(uploadId, chunks.length, fileId);

    // Verify upload session still exists before fetching chunks
    let progress = await temp.getUploadProgress(uploadId);
    expect(progress).not.toBeNull();

    // Verify chunks exist in temporary storage
    const chunkKeys = await unstorage.getKeys(`file:upload:${uploadId}:chunk:`);
    expect(chunkKeys.length).toBe(2);

    // Fetch all chunks via getChunk
    const chunk0 = await result.getChunk(0);
    expect(chunk0).toEqual(chunks[0]);

    // Verify chunk 0 was deleted from temporary storage
    const chunkKeysAfter0 = await unstorage.getKeys(`file:upload:${uploadId}:chunk:`);
    expect(chunkKeysAfter0.length).toBe(1);

    // Session should still exist (not all chunks fetched yet)
    progress = await temp.getUploadProgress(uploadId);
    expect(progress).not.toBeNull();

    const chunk1 = await result.getChunk(1);
    expect(chunk1).toEqual(chunks[1]);

    // Verify all chunks and session are cleaned up
    const chunkKeysAfter1 = await unstorage.getKeys(`file:upload:${uploadId}:chunk:`);
    expect(chunkKeysAfter1.length).toBe(0);

    progress = await temp.getUploadProgress(uploadId);
    expect(progress).toBeNull();

    // Verify session key is deleted
    const sessionKey = `file:upload:${uploadId}`;
    const sessionData = await unstorage.getItem(sessionKey);
    expect(sessionData).toBeNull();
  });

  it("should prevent double fetching of chunks via getChunk", async () => {
    const unstorage = createStorage();
    storage = new UnstorageFileStorage(unstorage);
    temp = new UnstorageTemporaryUploadStorage(unstorage);
    storage.temporaryUploadStorage = temp;

    const uploadId = "test-upload-id";
    const chunks = [new Uint8Array([1, 2, 3, 4, 5, 6])];
    const fileId = toBase64((await buildMerkleTree(chunks)).nodes.at(-1)!.hash!);

    await temp.beginUpload(uploadId, {
      filename: "test.txt",
      size: chunks[0].length,
      mimeType: "text/plain",
      encrypted: false,
      lastModified: Date.now(),
      documentId: "test-doc",
    });

    await temp.storeChunk(uploadId, 0, chunks[0], []);
    const result = await temp.completeUpload(uploadId, chunks.length, fileId);

    // First fetch should succeed
    const chunk = await result.getChunk(0);
    expect(chunk).toEqual(chunks[0]);

    // Second fetch should fail
    await expect(result.getChunk(0)).rejects.toThrow("Chunk 0 has already been fetched");
  });

  it("should not duplicate data - file persisted to durable storage, temp chunks cleaned up", async () => {
    const unstorage = createStorage();
    storage = new UnstorageFileStorage(unstorage);
    temp = new UnstorageTemporaryUploadStorage(unstorage);
    storage.temporaryUploadStorage = temp;

    const uploadId = "test-upload-id";
    const chunks = [new Uint8Array([1, 2, 3, 4, 5, 6])];
    const fileId = toBase64((await buildMerkleTree(chunks)).nodes.at(-1)!.hash!);

    await temp.beginUpload(uploadId, {
      filename: "test.txt",
      size: chunks[0].length,
      mimeType: "text/plain",
      encrypted: false,
      lastModified: Date.now(),
      documentId: "test-doc",
    });

    await temp.storeChunk(uploadId, 0, chunks[0], []);
    const result = await temp.completeUpload(uploadId, chunks.length, fileId);

    // Move file from temporary storage to durable storage incrementally
    await storage.storeFileFromUpload(result);

    // File should be in durable storage
    const file = await storage.getFile(result.fileId);
    expect(file).not.toBeNull();

    // Verify temporary upload chunks are cleaned up (no duplication)
    const tempChunkKeys = await unstorage.getKeys(`file:upload:${uploadId}:chunk:`);
    expect(tempChunkKeys.length).toBe(0);

    // Verify durable storage chunks still exist
    const durableChunkKeys = await unstorage.getKeys(`file:file:${fileId}:chunk:`);
    expect(durableChunkKeys.length).toBe(1);

    // File should still be retrievable from durable storage
    const retrievedFile = await storage.getFile(result.fileId);
    expect(retrievedFile).not.toBeNull();
    expect(retrievedFile!.chunks[0]).toEqual(chunks[0]);
  });

  describe("deleteFile", () => {
    it("deletes a single file", async () => {
      const unstorage = createStorage();
      const fileStorage = new UnstorageFileStorage(unstorage);
      const temp = new UnstorageTemporaryUploadStorage(unstorage);
      fileStorage.temporaryUploadStorage = temp;

      const documentId = "test-doc";
      const chunks = [new Uint8Array([1, 2, 3, 4, 5, 6])];
      const fileId = toBase64((await buildMerkleTree(chunks)).nodes.at(-1)!.hash!);

      const uploadId = "test-upload-id";
      await temp.beginUpload(uploadId, {
        filename: "test.txt",
        size: chunks[0].length,
        mimeType: "text/plain",
        encrypted: false,
        lastModified: Date.now(),
        documentId,
      });

      await temp.storeChunk(uploadId, 0, chunks[0], []);
      const result = await temp.completeUpload(uploadId, chunks.length, fileId);
      await fileStorage.storeFileFromUpload(result);

      // Verify file exists
      let file = await fileStorage.getFile(fileId);
      expect(file).not.toBeNull();

      // Verify file chunks exist in storage
      const chunkKeysBefore = await unstorage.getKeys(`file:file:${fileId}:chunk:`);
      expect(chunkKeysBefore.length).toBeGreaterThan(0);

      // Delete the file
      await fileStorage.deleteFile(fileId);

      // Verify file is deleted
      file = await fileStorage.getFile(fileId);
      expect(file).toBeNull();

      // Verify file chunks are deleted
      const chunkKeysAfter = await unstorage.getKeys(`file:file:${fileId}:chunk:`);
      expect(chunkKeysAfter.length).toBe(0);

      // Verify file metadata is deleted
      const fileKey = `file:file:${fileId}`;
      const fileData = await unstorage.getItem(fileKey);
      expect(fileData).toBeNull();
    });
  });
});
