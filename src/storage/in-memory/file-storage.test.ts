import { describe, expect, it } from "bun:test";
import { buildMerkleTree, CHUNK_SIZE } from "../../lib/merkle-tree/merkle-tree";
import { InMemoryFileStorage } from "./file-storage";
import { InMemoryTemporaryUploadStorage } from "./temporary-upload-storage";
import { toBase64 } from "lib0/buffer";

describe("InMemoryFileStorage", () => {
  it("stores completed files and can retrieve them", async () => {
    const storage = new InMemoryFileStorage();
    const temp = new InMemoryTemporaryUploadStorage({
      onComplete: (file) => storage.storeFile(file),
    });
    storage.temporaryUploadStorage = temp;

    const uploadId = "test-upload-id";
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])];
    const merkleTree = buildMerkleTree(chunks);
    const contentId = merkleTree.nodes[merkleTree.nodes.length - 1].hash!;
    const fileId = toBase64(contentId);

    await temp.beginUpload(uploadId, {
      filename: "test.txt",
      size: chunks[0].length + chunks[1].length,
      mimeType: "text/plain",
      encrypted: false,
      lastModified: Date.now(),
      documentId: "test-doc",
    });

    for (let i = 0; i < chunks.length; i++) {
      await temp.storeChunk(uploadId, i, chunks[i], []);
    }

    await temp.completeUpload(uploadId, fileId);

    const file = await storage.getFile(fileId);
    expect(file).not.toBeNull();
    expect(file!.id).toBe(fileId);
    expect(file!.metadata.filename).toBe("test.txt");
    expect(file!.chunks.length).toBe(2);
    expect(file!.chunks[0]).toEqual(chunks[0]);
    expect(file!.chunks[1]).toEqual(chunks[1]);
  });

  it("tracks upload progress and chunk completion", async () => {
    const storage = new InMemoryFileStorage();
    const temp = new InMemoryTemporaryUploadStorage({
      onComplete: (file) => storage.storeFile(file),
    });
    storage.temporaryUploadStorage = temp;

    const uploadId = "test-upload-id";
    const chunks = [new Uint8Array(CHUNK_SIZE), new Uint8Array(CHUNK_SIZE)];
    chunks[0].fill(1);
    chunks[1].fill(2);
    const contentId = buildMerkleTree(chunks).nodes.at(-1)!.hash!;
    const fileId = toBase64(contentId);

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
    await temp.completeUpload(uploadId, fileId);
  });

  it("should cleanup expired uploads", async () => {
    const storage = new InMemoryFileStorage();
    const temp = new InMemoryTemporaryUploadStorage({
      uploadTimeoutMs: 100,
      onComplete: (file) => storage.storeFile(file),
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

    // Wait for expiration
    await new Promise((resolve) => setTimeout(resolve, 150));

    await temp.cleanupExpiredUploads();

    const progress = await temp.getUploadProgress(uploadId);
    expect(progress).toBeNull();
  });
});
