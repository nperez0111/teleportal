import { beforeEach, describe, expect, it } from "bun:test";
import { createStorage } from "unstorage";
import { buildMerkleTree, CHUNK_SIZE } from "../../lib/merkle-tree/merkle-tree";
import { toBase64 } from "lib0/buffer";
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
    const contentId = buildMerkleTree(chunks).nodes.at(-1)!.hash!;
    const fileId = toBase64(contentId);

    await temp.beginUpload(uploadId, {
      filename: "test.txt",
      size: chunks[0].length,
      mimeType: "text/plain",
      encrypted: false,
      lastModified: Date.now(),
      documentId: "test-doc",
    });

    for (let i = 0; i < chunks.length; i++) {
      await temp.storeChunk(uploadId, i, chunks[i], []);
    }

    const result = await temp.completeUpload(uploadId, fileId);

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
    const fileId = toBase64(buildMerkleTree(chunks).nodes.at(-1)!.hash!);

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
    await temp.completeUpload(uploadId);
  });

  it("cleans up expired uploads", async () => {
    const unstorage = createStorage();
    storage = new UnstorageFileStorage(unstorage);
    temp = new UnstorageTemporaryUploadStorage(unstorage, {
      uploadTimeoutMs: 50,
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

    await new Promise((resolve) => setTimeout(resolve, 75));
    await temp.cleanupExpiredUploads();

    const progress = await temp.getUploadProgress(uploadId);
    expect(progress).toBeNull();
  });
});
