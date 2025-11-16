import { describe, expect, it } from "bun:test";
import { buildMerkleTree, CHUNK_SIZE } from "../../lib/protocol/file-upload";
import { InMemoryFileStorage } from "./file-storage";

describe("InMemoryFileStorage", () => {
  it("should initiate an upload", async () => {
    const storage = new InMemoryFileStorage();
    const fileId = "test-file-id";

    await storage.initiateUpload(fileId, {
      filename: "test.txt",
      size: 1024,
      mimeType: "text/plain",
      encrypted: false,
      createdAt: Date.now(),
    });

    const progress = await storage.getUploadProgress(fileId);
    expect(progress).not.toBeNull();
    expect(progress!.metadata.filename).toBe("test.txt");
    expect(progress!.metadata.size).toBe(1024);
  });

  it("should store chunks and track progress", async () => {
    const storage = new InMemoryFileStorage();
    const fileId = "test-file-id";

    await storage.initiateUpload(fileId, {
      filename: "test.txt",
      size: CHUNK_SIZE * 2,
      mimeType: "text/plain",
      encrypted: false,
      createdAt: Date.now(),
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
    const storage = new InMemoryFileStorage();
    const fileId = "test-file-id";

    const chunks = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5, 6]),
    ];

    await storage.initiateUpload(fileId, {
      filename: "test.txt",
      size: chunks[0].length + chunks[1].length,
      mimeType: "text/plain",
      encrypted: false,
      createdAt: Date.now(),
    });

    // Build merkle tree to get contentId
    const merkleTree = buildMerkleTree(chunks);
    const contentId = merkleTree.nodes[merkleTree.nodes.length - 1].hash;

    // Store chunks
    for (let i = 0; i < chunks.length; i++) {
      const proof = [];
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
    const storage = new InMemoryFileStorage();
    const fileId = "test-file-id";

    const chunks = [new Uint8Array([1, 2, 3])];

    await storage.initiateUpload(fileId, {
      filename: "test.txt",
      size: chunks[0].length,
      mimeType: "text/plain",
      encrypted: false,
      createdAt: Date.now(),
    });

    await storage.storeChunk(fileId, 0, chunks[0], []);

    const wrongContentId = new Uint8Array(32);
    wrongContentId.fill(99);

    await expect(
      storage.completeUpload(fileId, wrongContentId),
    ).rejects.toThrow("Merkle root hash mismatch");
  });

  it("should reject completion with missing chunks", async () => {
    const storage = new InMemoryFileStorage();
    const fileId = "test-file-id";

    await storage.initiateUpload(fileId, {
      filename: "test.txt",
      size: CHUNK_SIZE * 2,
      mimeType: "text/plain",
      encrypted: false,
      createdAt: Date.now(),
    });

    const chunk = new Uint8Array(CHUNK_SIZE);
    await storage.storeChunk(fileId, 0, chunk, []);

    const merkleTree = buildMerkleTree([chunk, new Uint8Array(CHUNK_SIZE)]);
    const contentId = merkleTree.nodes[merkleTree.nodes.length - 1].hash;

    await expect(
      storage.completeUpload(fileId, contentId),
    ).rejects.toThrow("Missing chunk 1 for file test-file-id");
  });

  it("should cleanup expired uploads", async () => {
    const storage = new InMemoryFileStorage(100); // 100ms timeout

    const fileId = "test-file-id";
    await storage.initiateUpload(fileId, {
      filename: "test.txt",
      size: 1024,
      mimeType: "text/plain",
      encrypted: false,
      createdAt: Date.now(),
    });

    // Wait for expiration
    await new Promise((resolve) => setTimeout(resolve, 150));

    await storage.cleanupExpiredUploads();

    const progress = await storage.getUploadProgress(fileId);
    expect(progress).toBeNull();
  });
});
