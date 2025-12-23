import { describe, expect, it } from "bun:test";
import { buildMerkleTree, CHUNK_SIZE } from "../../lib/merkle-tree/merkle-tree";
import { InMemoryFileStorage } from "./file-storage";
import { InMemoryTemporaryUploadStorage } from "./temporary-upload-storage";
import { toBase64 } from "lib0/buffer";
import type { Document, DocumentMetadata, DocumentStorage } from "../types";
import type { StateVector, SyncStep2Update, Update } from "teleportal";

describe("InMemoryFileStorage", () => {
  it("stores completed files and can retrieve them", async () => {
    const storage = new InMemoryFileStorage();
    const temp = new InMemoryTemporaryUploadStorage();
    storage.temporaryUploadStorage = temp;

    const uploadId = "test-upload-id";
    // For a small file (6 bytes), it should be a single chunk
    const chunks = [new Uint8Array([1, 2, 3, 4, 5, 6])];
    const merkleTree = buildMerkleTree(chunks);
    const contentId = merkleTree.nodes[merkleTree.nodes.length - 1].hash!;
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
    await storage.storeFileFromUpload(result);

    const file = await storage.getFile(result.fileId);
    expect(file).not.toBeNull();
    expect(file!.id).toBe(fileId);
    expect(file!.metadata.filename).toBe("test.txt");
    expect(file!.chunks.length).toBe(1);
    expect(file!.chunks[0]).toEqual(chunks[0]);
  });

  it("tracks upload progress and chunk completion", async () => {
    const storage = new InMemoryFileStorage();
    const temp = new InMemoryTemporaryUploadStorage();
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
    await temp.completeUpload(uploadId);
  });

  it("should cleanup expired uploads", async () => {
    const storage = new InMemoryFileStorage();
    const temp = new InMemoryTemporaryUploadStorage({
      uploadTimeoutMs: 100,
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

  it("should cleanup upload session after all chunks are fetched via getChunk", async () => {
    const storage = new InMemoryFileStorage();
    const temp = new InMemoryTemporaryUploadStorage();
    storage.temporaryUploadStorage = temp;

    const uploadId = "test-upload-id";
    // Create a file that requires 2 chunks (CHUNK_SIZE + 1 byte)
    const chunks = [new Uint8Array(CHUNK_SIZE).fill(1), new Uint8Array([2])];
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

    const result = await temp.completeUpload(uploadId, fileId);

    // Verify upload session still exists before fetching chunks
    let progress = await temp.getUploadProgress(uploadId);
    expect(progress).not.toBeNull();

    // Fetch all chunks via getChunk
    const chunk0 = await result.getChunk(0);
    expect(chunk0).toEqual(chunks[0]);

    // Session should still exist (not all chunks fetched yet)
    progress = await temp.getUploadProgress(uploadId);
    expect(progress).not.toBeNull();

    const chunk1 = await result.getChunk(1);
    expect(chunk1).toEqual(chunks[1]);

    // Session should be cleaned up after all chunks are fetched
    progress = await temp.getUploadProgress(uploadId);
    expect(progress).toBeNull();
  });

  it("should prevent double fetching of chunks via getChunk", async () => {
    const storage = new InMemoryFileStorage();
    const temp = new InMemoryTemporaryUploadStorage();
    storage.temporaryUploadStorage = temp;

    const uploadId = "test-upload-id";
    const chunks = [new Uint8Array([1, 2, 3, 4, 5, 6])];
    const merkleTree = buildMerkleTree(chunks);
    const contentId = merkleTree.nodes[merkleTree.nodes.length - 1].hash!;
    const fileId = toBase64(contentId);

    await temp.beginUpload(uploadId, {
      filename: "test.txt",
      size: chunks[0].length,
      mimeType: "text/plain",
      encrypted: false,
      lastModified: Date.now(),
      documentId: "test-doc",
    });

    await temp.storeChunk(uploadId, 0, chunks[0], []);
    const result = await temp.completeUpload(uploadId, fileId);

    // First fetch should succeed
    const chunk = await result.getChunk(0);
    expect(chunk).toEqual(chunks[0]);

    // Second fetch should fail
    await expect(result.getChunk(0)).rejects.toThrow(
      "Chunk 0 has already been fetched",
    );
  });

  it("should allow moving chunks from in-memory temp storage to unstorage file storage", async () => {
    const { createStorage } = await import("unstorage");
    const { UnstorageFileStorage } = await import("../unstorage/file-storage");

    const unstorage = createStorage();
    const durableStorage = new UnstorageFileStorage(unstorage, {
      keyPrefix: "file",
    });

    const temp = new InMemoryTemporaryUploadStorage();

    const uploadId = "test-upload-id";
    // Create a file that requires 2 chunks (CHUNK_SIZE + 1 byte)
    const chunks = [new Uint8Array(CHUNK_SIZE).fill(1), new Uint8Array([2])];
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

    const result = await temp.completeUpload(uploadId, fileId);

    // Move file from temporary storage to durable storage incrementally
    await durableStorage.storeFileFromUpload(result);

    // Verify file is in durable storage
    const file = await durableStorage.getFile(result.fileId);
    expect(file).not.toBeNull();
    expect(file!.chunks).toEqual(chunks);

    // Verify temp storage session is cleaned up after fetching chunks
    const progress = await temp.getUploadProgress(uploadId);
    expect(progress).toBeNull();
  });

  describe("deleteFile", () => {
    it("deletes a single file and removes it from document metadata", async () => {
      // Create a mock document storage
      class MockDocumentStorage implements DocumentStorage {
        readonly type = "document-storage" as const;
        storageType: "unencrypted" = "unencrypted";
        fileStorage = undefined;
        milestoneStorage = undefined;
        metadata: Map<string, DocumentMetadata> = new Map();

        async handleSyncStep1(
          documentId: string,
          syncStep1: StateVector,
        ): Promise<Document> {
          return {
            id: documentId,
            metadata: await this.getDocumentMetadata(documentId),
            content: {
              update: new Uint8Array() as unknown as Update,
              stateVector: syncStep1,
            },
          };
        }

        async handleSyncStep2(
          _documentId: string,
          _syncStep2: SyncStep2Update,
        ): Promise<void> {}

        async handleUpdate(
          _documentId: string,
          _update: Update,
        ): Promise<void> {}

        async getDocument(documentId: string): Promise<Document | null> {
          return {
            id: documentId,
            metadata: await this.getDocumentMetadata(documentId),
            content: {
              update: new Uint8Array() as unknown as Update,
              stateVector: new Uint8Array() as unknown as StateVector,
            },
          };
        }

        async writeDocumentMetadata(
          documentId: string,
          metadata: DocumentMetadata,
        ): Promise<void> {
          this.metadata.set(documentId, metadata);
        }

        async getDocumentMetadata(
          documentId: string,
        ): Promise<DocumentMetadata> {
          const now = Date.now();
          return (
            this.metadata.get(documentId) ?? {
              createdAt: now,
              updatedAt: now,
              encrypted: false,
            }
          );
        }

        async deleteDocument(_documentId: string): Promise<void> {}

        transaction<T>(_documentId: string, cb: () => Promise<T>): Promise<T> {
          return cb();
        }
      }

      const documentStorage = new MockDocumentStorage();
      const fileStorage = new InMemoryFileStorage({ documentStorage });
      const temp = new InMemoryTemporaryUploadStorage();
      fileStorage.temporaryUploadStorage = temp;

      const documentId = "test-doc";
      const chunks = [new Uint8Array([1, 2, 3, 4, 5, 6])];
      const merkleTree = buildMerkleTree(chunks);
      const contentId = merkleTree.nodes[merkleTree.nodes.length - 1].hash!;
      const fileId = toBase64(contentId);

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
      const result = await temp.completeUpload(uploadId, fileId);
      await fileStorage.storeFileFromUpload(result);

      // Verify file exists
      let file = await fileStorage.getFile(fileId);
      expect(file).not.toBeNull();

      // Verify file is in document metadata
      let metadata = await documentStorage.getDocumentMetadata(documentId);
      expect(metadata.files).toContain(fileId);

      // Delete the file
      await fileStorage.deleteFile(fileId);

      // Verify file is deleted
      file = await fileStorage.getFile(fileId);
      expect(file).toBeNull();

      // Verify file is removed from document metadata
      metadata = await documentStorage.getDocumentMetadata(documentId);
      expect(metadata.files).not.toContain(fileId);
      expect(metadata.files?.length).toBe(0);
    });
  });

  describe("deleteFilesByDocument", () => {
    it("deletes all files for a document and clears document metadata", async () => {
      // Create a mock document storage
      class MockDocumentStorage implements DocumentStorage {
        readonly type = "document-storage" as const;
        storageType: "unencrypted" = "unencrypted";
        fileStorage = undefined;
        milestoneStorage = undefined;
        metadata: Map<string, DocumentMetadata> = new Map();

        async handleSyncStep1(
          documentId: string,
          syncStep1: StateVector,
        ): Promise<Document> {
          return {
            id: documentId,
            metadata: await this.getDocumentMetadata(documentId),
            content: {
              update: new Uint8Array() as unknown as Update,
              stateVector: syncStep1,
            },
          };
        }

        async handleSyncStep2(
          _documentId: string,
          _syncStep2: SyncStep2Update,
        ): Promise<void> {}

        async handleUpdate(
          _documentId: string,
          _update: Update,
        ): Promise<void> {}

        async getDocument(documentId: string): Promise<Document | null> {
          return {
            id: documentId,
            metadata: await this.getDocumentMetadata(documentId),
            content: {
              update: new Uint8Array() as unknown as Update,
              stateVector: new Uint8Array() as unknown as StateVector,
            },
          };
        }

        async writeDocumentMetadata(
          documentId: string,
          metadata: DocumentMetadata,
        ): Promise<void> {
          this.metadata.set(documentId, metadata);
        }

        async getDocumentMetadata(
          documentId: string,
        ): Promise<DocumentMetadata> {
          const now = Date.now();
          return (
            this.metadata.get(documentId) ?? {
              createdAt: now,
              updatedAt: now,
              encrypted: false,
            }
          );
        }

        async deleteDocument(_documentId: string): Promise<void> {}

        transaction<T>(_documentId: string, cb: () => Promise<T>): Promise<T> {
          return cb();
        }
      }

      const documentStorage = new MockDocumentStorage();
      const fileStorage = new InMemoryFileStorage({ documentStorage });
      const temp = new InMemoryTemporaryUploadStorage();
      fileStorage.temporaryUploadStorage = temp;

      const documentId = "test-doc";

      // Create and store multiple files
      const fileIds: string[] = [];
      for (let i = 0; i < 3; i++) {
        const chunks = [new Uint8Array([i, i + 1, i + 2, i + 3])];
        const merkleTree = buildMerkleTree(chunks);
        const contentId = merkleTree.nodes[merkleTree.nodes.length - 1].hash!;
        const fileId = toBase64(contentId);
        fileIds.push(fileId);

        const uploadId = `test-upload-${i}`;
        await temp.beginUpload(uploadId, {
          filename: `test-${i}.txt`,
          size: chunks[0].length,
          mimeType: "text/plain",
          encrypted: false,
          lastModified: Date.now(),
          documentId,
        });

        await temp.storeChunk(uploadId, 0, chunks[0], []);
        const result = await temp.completeUpload(uploadId, fileId);
        await fileStorage.storeFileFromUpload(result);
      }

      // Verify all files exist
      for (const fileId of fileIds) {
        const file = await fileStorage.getFile(fileId);
        expect(file).not.toBeNull();
      }

      // Verify all files are in document metadata
      let metadata = await documentStorage.getDocumentMetadata(documentId);
      expect(metadata.files?.length).toBe(3);
      for (const fileId of fileIds) {
        expect(metadata.files).toContain(fileId);
      }

      // Delete all files for the document
      await fileStorage.deleteFilesByDocument(documentId);

      // Verify all files are deleted
      for (const fileId of fileIds) {
        const file = await fileStorage.getFile(fileId);
        expect(file).toBeNull();
      }

      // Verify document metadata is cleared
      metadata = await documentStorage.getDocumentMetadata(documentId);
      expect(metadata.files).toEqual([]);
    });

    it("handles deleting files when document has no files", async () => {
      class MockDocumentStorage implements DocumentStorage {
        readonly type = "document-storage" as const;
        storageType: "unencrypted" = "unencrypted";
        fileStorage = undefined;
        milestoneStorage = undefined;
        metadata: Map<string, DocumentMetadata> = new Map();

        async handleSyncStep1(
          documentId: string,
          syncStep1: StateVector,
        ): Promise<Document> {
          return {
            id: documentId,
            metadata: await this.getDocumentMetadata(documentId),
            content: {
              update: new Uint8Array() as unknown as Update,
              stateVector: syncStep1,
            },
          };
        }

        async handleSyncStep2(
          _documentId: string,
          _syncStep2: SyncStep2Update,
        ): Promise<void> {}

        async handleUpdate(
          _documentId: string,
          _update: Update,
        ): Promise<void> {}

        async getDocument(documentId: string): Promise<Document | null> {
          return {
            id: documentId,
            metadata: await this.getDocumentMetadata(documentId),
            content: {
              update: new Uint8Array() as unknown as Update,
              stateVector: new Uint8Array() as unknown as StateVector,
            },
          };
        }

        async writeDocumentMetadata(
          documentId: string,
          metadata: DocumentMetadata,
        ): Promise<void> {
          this.metadata.set(documentId, metadata);
        }

        async getDocumentMetadata(
          documentId: string,
        ): Promise<DocumentMetadata> {
          const now = Date.now();
          return (
            this.metadata.get(documentId) ?? {
              createdAt: now,
              updatedAt: now,
              encrypted: false,
            }
          );
        }

        async deleteDocument(_documentId: string): Promise<void> {}

        transaction<T>(_documentId: string, cb: () => Promise<T>): Promise<T> {
          return cb();
        }
      }

      const documentStorage = new MockDocumentStorage();
      const fileStorage = new InMemoryFileStorage({ documentStorage });

      const documentId = "test-doc";

      // Delete files for a document with no files (should not error)
      await fileStorage.deleteFilesByDocument(documentId);

      // Verify metadata files array is empty (not undefined, as it gets set to [])
      const metadata = await documentStorage.getDocumentMetadata(documentId);
      expect(metadata.files).toEqual([]);
    });
  });
});
