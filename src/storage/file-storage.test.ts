import { describe, expect, it } from "bun:test";
import {
  InMemoryFileStorage,
  type FileMetadata,
} from "./file-storage";
import { buildMerkleTree, CHUNK_SIZE } from "../lib/protocol/file-upload";

describe("InMemoryFileStorage", () => {
  it("should initiate upload", async () => {
    const storage = new InMemoryFileStorage();
    const metadata: FileMetadata = {
      filename: "test.txt",
      size: 1024,
      mimeType: "text/plain",
      encrypted: false,
      createdAt: Date.now(),
    };

    await storage.initiateUpload("file-1", metadata);
    const progress = await storage.getUploadProgress("file-1");

    expect(progress).not.toBeNull();
    expect(progress!.fileId).toBe("file-1");
    expect(progress!.metadata.filename).toBe("test.txt");
  });

  it("should store chunks", async () => {
    const storage = new InMemoryFileStorage();
    const metadata: FileMetadata = {
      filename: "test.txt",
      size: CHUNK_SIZE * 2,
      mimeType: "text/plain",
      encrypted: false,
      createdAt: Date.now(),
    };

    await storage.initiateUpload("file-1", metadata);

    const chunk1 = new Uint8Array(CHUNK_SIZE).fill(1);
    const chunk2 = new Uint8Array(CHUNK_SIZE).fill(2);
    const proof1 = [new Uint8Array(32).fill(1)];
    const proof2 = [new Uint8Array(32).fill(2)];

    await storage.storeChunk("file-1", 0, chunk1, proof1);
    await storage.storeChunk("file-1", 1, chunk2, proof2);

    const progress = await storage.getUploadProgress("file-1");
    expect(progress!.chunks.size).toBe(2);
    expect(progress!.bytesUploaded).toBe(CHUNK_SIZE * 2);
  });

  it("should complete upload and store file", async () => {
    const storage = new InMemoryFileStorage();
    const metadata: FileMetadata = {
      filename: "test.txt",
      size: CHUNK_SIZE * 2,
      mimeType: "text/plain",
      encrypted: false,
      createdAt: Date.now(),
    };

    await storage.initiateUpload("file-1", metadata);

    const chunk1 = new Uint8Array(CHUNK_SIZE).fill(1);
    const chunk2 = new Uint8Array(CHUNK_SIZE).fill(2);
    const chunks = [chunk1, chunk2];
    const tree = buildMerkleTree(chunks);
    const contentId = tree.root.hash;

    const proof1 = [new Uint8Array(32).fill(1)];
    const proof2 = [new Uint8Array(32).fill(2)];

    await storage.storeChunk("file-1", 0, chunk1, proof1);
    await storage.storeChunk("file-1", 1, chunk2, proof2);

    await storage.completeUpload("file-1", contentId);

    // Upload should be removed
    const progress = await storage.getUploadProgress("file-1");
    expect(progress).toBeNull();

    // File should be stored by contentId
    const { toBase64 } = await import("lib0/buffer");
    const contentIdBase64 = toBase64(contentId);
    const file = await storage.getFile(contentIdBase64);
    expect(file).not.toBeNull();
    expect(file!.chunks.length).toBe(2);
    expect(file!.metadata.filename).toBe("test.txt");
  });

  it("should reject completion with mismatched contentId", async () => {
    const storage = new InMemoryFileStorage();
    const metadata: FileMetadata = {
      filename: "test.txt",
      size: CHUNK_SIZE,
      mimeType: "text/plain",
      encrypted: false,
      createdAt: Date.now(),
    };

    await storage.initiateUpload("file-1", metadata);

    const chunk = new Uint8Array(CHUNK_SIZE).fill(1);
    const proof = [new Uint8Array(32).fill(1)];

    await storage.storeChunk("file-1", 0, chunk, proof);

    const wrongContentId = new Uint8Array(32).fill(99);

    await expect(
      storage.completeUpload("file-1", wrongContentId),
    ).rejects.toThrow("ContentId mismatch");
  });

  it("should cleanup expired uploads", async () => {
    const storage = new InMemoryFileStorage(100); // 100ms expiration
    const metadata: FileMetadata = {
      filename: "test.txt",
      size: 1024,
      mimeType: "text/plain",
      encrypted: false,
      createdAt: Date.now() - 200, // 200ms ago
    };

    await storage.initiateUpload("file-1", metadata);
    await storage.cleanupExpiredUploads();

    const progress = await storage.getUploadProgress("file-1");
    expect(progress).toBeNull();
  });
});
