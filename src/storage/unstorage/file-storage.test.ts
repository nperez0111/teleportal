import { describe, expect, it, beforeEach } from "bun:test";
import { createStorage } from "unstorage";
import { buildMerkleTree, CHUNK_SIZE } from "../../lib/merkle-tree/merkle-tree";
import { UnstorageFileStorage } from "./file-storage";

describe("UnstorageFileStorage", () => {
  let storage: UnstorageFileStorage;

  beforeEach(() => {
    // Create a fresh in-memory storage for each test
    const unstorage = createStorage();
    storage = new UnstorageFileStorage(unstorage);
  });

  it("should initiate an upload", async () => {
    const fileId = "test-file-id";

    await storage.initiateUpload(fileId, {
      filename: "test.txt",
      size: 1024,
      mimeType: "text/plain",
      encrypted: false,
      lastModified: Date.now(),
    });

    const progress = await storage.getUploadProgress(fileId);
    expect(progress).not.toBeNull();
    expect(progress!.metadata.filename).toBe("test.txt");
    expect(progress!.metadata.size).toBe(1024);
  });

  it("should store chunks and track progress", async () => {
    const fileId = "test-file-id";

    await storage.initiateUpload(fileId, {
      filename: "test.txt",
      size: CHUNK_SIZE * 2,
      mimeType: "text/plain",
      encrypted: false,
      lastModified: Date.now(),
    });

    const chunk1 = new Uint8Array(CHUNK_SIZE);
    chunk1.fill(1);
    const proof1: Uint8Array[] = [];

    await storage.storeChunk(fileId, 0, chunk1, proof1);

    const progress = await storage.getUploadProgress(fileId);
    expect(progress!.bytesUploaded).toBe(CHUNK_SIZE);
    expect(progress!.chunks.has(0)).toBe(true);
  });

  it("should complete an upload and store file", async () => {
    const fileId = "test-file-id";

    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])];

    await storage.initiateUpload(fileId, {
      filename: "test.txt",
      size: chunks[0].length + chunks[1].length,
      mimeType: "text/plain",
      encrypted: false,
      lastModified: Date.now(),
    });

    // Build merkle tree to get contentId
    const merkleTree = buildMerkleTree(chunks);
    const contentId = merkleTree.nodes[merkleTree.nodes.length - 1].hash;

    // Store chunks
    for (let i = 0; i < chunks.length; i++) {
      const proof: Uint8Array[] = [];
      await storage.storeChunk(fileId, i, chunks[i], proof);
    }

    // Complete upload
    await storage.completeUpload(fileId, contentId);

    // Verify file is stored
    const file = await storage.getFile(contentId);
    expect(file).not.toBeNull();
    expect(file!.metadata.filename).toBe("test.txt");
    expect(file!.chunks.length).toBe(2);
    expect(file!.chunks[0]).toEqual(chunks[0]);
    expect(file!.chunks[1]).toEqual(chunks[1]);

    // Verify upload session is removed
    const progress = await storage.getUploadProgress(fileId);
    expect(progress).toBeNull();
  });

  it("should reject completion with wrong contentId", async () => {
    const fileId = "test-file-id";

    const chunks = [new Uint8Array([1, 2, 3])];

    await storage.initiateUpload(fileId, {
      filename: "test.txt",
      size: chunks[0].length,
      mimeType: "text/plain",
      encrypted: false,
      lastModified: Date.now(),
    });

    await storage.storeChunk(fileId, 0, chunks[0], []);

    const wrongContentId = new Uint8Array(32);
    wrongContentId.fill(99);

    await expect(
      storage.completeUpload(fileId, wrongContentId),
    ).rejects.toThrow("Merkle root hash mismatch");
  });

  it("should reject completion with missing chunks", async () => {
    const fileId = "test-file-id";

    await storage.initiateUpload(fileId, {
      filename: "test.txt",
      size: CHUNK_SIZE * 2,
      mimeType: "text/plain",
      encrypted: false,
      lastModified: Date.now(),
    });

    const chunk = new Uint8Array(CHUNK_SIZE);
    await storage.storeChunk(fileId, 0, chunk, []);

    const merkleTree = buildMerkleTree([chunk, new Uint8Array(CHUNK_SIZE)]);
    const contentId = merkleTree.nodes[merkleTree.nodes.length - 1].hash;

    await expect(storage.completeUpload(fileId, contentId)).rejects.toThrow(
      "Missing chunk 1 for file test-file-id",
    );
  });

  it("should cleanup expired uploads", async () => {
    const unstorage = createStorage();
    const storageWithShortTimeout = new UnstorageFileStorage(unstorage, {
      uploadTimeoutMs: 100, // 100ms timeout
    });

    const fileId = "test-file-id";
    await storageWithShortTimeout.initiateUpload(fileId, {
      filename: "test.txt",
      size: 1024,
      mimeType: "text/plain",
      encrypted: false,
      lastModified: Date.now(),
    });

    // Wait for expiration
    await new Promise((resolve) => setTimeout(resolve, 150));

    await storageWithShortTimeout.cleanupExpiredUploads();

    const progress = await storageWithShortTimeout.getUploadProgress(fileId);
    expect(progress).toBeNull();
  });

  it("should persist data across storage instances", async () => {
    const unstorage = createStorage();

    const fileId = "test-file-id";
    const storage1 = new UnstorageFileStorage(unstorage);

    await storage1.initiateUpload(fileId, {
      filename: "test.txt",
      size: 1024,
      mimeType: "text/plain",
      encrypted: false,
      lastModified: Date.now(),
    });

    // Create a new storage instance with the same unstorage backend
    const storage2 = new UnstorageFileStorage(unstorage);

    // Should be able to retrieve the upload session
    const progress = await storage2.getUploadProgress(fileId);
    expect(progress).not.toBeNull();
    expect(progress!.metadata.filename).toBe("test.txt");
  });

  it("should handle multiple chunks correctly", async () => {
    const fileId = "test-file-id";
    const numChunks = 5;
    const chunkSize = 100;

    await storage.initiateUpload(fileId, {
      filename: "test.txt",
      size: numChunks * chunkSize,
      mimeType: "text/plain",
      encrypted: false,
      lastModified: Date.now(),
    });

    // Store chunks in reverse order to test ordering
    for (let i = numChunks - 1; i >= 0; i--) {
      const chunk = new Uint8Array(chunkSize);
      chunk.fill(i);
      await storage.storeChunk(fileId, i, chunk, []);
    }

    const progress = await storage.getUploadProgress(fileId);
    expect(progress!.chunks.size).toBe(numChunks);
    expect(progress!.bytesUploaded).toBe(numChunks * chunkSize);

    // Verify chunks are retrieved in correct order
    // @ts-expect-error - getChunksForUpload is protected but we're testing it
    const chunks = await storage.getChunksForUpload(fileId);
    expect(chunks).not.toBeNull();
    expect(chunks!.length).toBe(numChunks);
    // First chunk should be filled with 0
    expect(chunks![0][0]).toBe(0);
    // Last chunk should be filled with numChunks - 1
    expect(chunks![numChunks - 1][0]).toBe(numChunks - 1);
  });

  it("should use custom key prefix", async () => {
    const unstorage = createStorage();
    const customStorage = new UnstorageFileStorage(unstorage, {
      keyPrefix: "custom",
    });

    const fileId = "test-file-id";
    await customStorage.initiateUpload(fileId, {
      filename: "test.txt",
      size: 1024,
      mimeType: "text/plain",
      encrypted: false,
      lastModified: Date.now(),
    });

    // Check that keys use the custom prefix
    const keys = await unstorage.getKeys("custom:");
    expect(keys.length).toBeGreaterThan(0);
    expect(keys[0]).toContain("custom:");
  });
});
