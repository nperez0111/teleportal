import type { Storage } from "unstorage";
import { CHUNK_SIZE } from "../../lib/merkle-tree/merkle-tree";
import type {
  Document,
  DocumentMetadataUpdater,
  DocumentStorage,
  File,
  FileMetadata,
  FileStorage,
  FileUploadResult,
  TemporaryUploadStorage,
} from "../types";

/**
 * Unstorage-based implementation of {@link FileStorage}.
 *
 * Note: Upload session management is handled by a {@link TemporaryUploadStorage}
 * implementation (see `UnstorageTemporaryUploadStorage`).
 */
export class UnstorageFileStorage implements FileStorage {
  readonly type = "file-storage" as const;

  temporaryUploadStorage?: TemporaryUploadStorage;
  #storage: Storage;
  #keyPrefix: string;
  #metadataUpdater?: DocumentMetadataUpdater;
  #documentStorage?: DocumentStorage;

  constructor(
    storage: Storage,
    options?: {
      keyPrefix?: string;
      metadataUpdater?: DocumentMetadataUpdater;
      documentStorage?: DocumentStorage;
      temporaryUploadStorage?: TemporaryUploadStorage;
    },
  ) {
    this.#storage = storage;
    this.#keyPrefix = options?.keyPrefix ?? "file";
    this.#documentStorage = options?.documentStorage;
    // If documentStorage is provided, use it as metadataUpdater too
    // (since DocumentStorage extends DocumentMetadataUpdater)
    this.#metadataUpdater = options?.metadataUpdater ?? options?.documentStorage;
    this.temporaryUploadStorage = options?.temporaryUploadStorage;
  }

  /**
   * Set the document storage reference after construction.
   * This is used by factory functions to wire up the circular dependency.
   */
  setDocumentStorage(documentStorage: DocumentStorage): void {
    this.#documentStorage = documentStorage;
    // Also set metadataUpdater if not already set
    // DocumentStorage implements DocumentMetadataUpdater
    if (!this.#metadataUpdater) {
      this.#metadataUpdater = documentStorage as DocumentMetadataUpdater;
    }
  }

  #getFileKey(fileId: string): string {
    return `${this.#keyPrefix}:file:${fileId}`;
  }

  /**
   * Store a completed file (helper for temporary upload storage composition).
   * This is intentionally not part of the public `FileStorage` interface.
   */
  async storeFile(file: File): Promise<void> {
    const fileKey = this.#getFileKey(file.id);

    await this.#storage.setItem(fileKey, {
      metadata: file.metadata,
      contentId: Array.from(file.contentId),
      chunkKeys: file.chunks.map((_, index) => `${fileKey}:chunk:${index}`),
    });

    await Promise.all(
      file.chunks.map((chunk, index) =>
        this.#storage.setItemRaw(`${fileKey}:chunk:${index}`, chunk),
      ),
    );

    const documentId = file.metadata.documentId;
    if (this.#metadataUpdater && documentId) {
      await this.#metadataUpdater.addFileToDocument(documentId, file.id);
    }
  }

  async getFile(fileId: File["id"]): Promise<File | null> {
    const fileKey = this.#getFileKey(fileId);
    const serialized = await this.#storage.getItem<{
      metadata: FileMetadata;
      contentId: number[];
      chunkKeys: string[];
    }>(fileKey);

    if (!serialized) return null;

    const chunks = await Promise.all(
      serialized.chunkKeys.map((chunkKey) =>
        this.#storage.getItemRaw<Uint8Array>(chunkKey),
      ),
    );
    const validChunks = chunks.filter((c): c is Uint8Array => c !== null);

    return {
      id: fileId,
      metadata: serialized.metadata,
      chunks: validChunks,
      contentId: new Uint8Array(serialized.contentId),
    };
  }

  /**
   * Internal method to delete file data without updating document metadata.
   * This avoids transaction deadlocks when called from within a transaction.
   */
  async #deleteFileData(fileId: File["id"]): Promise<FileMetadata | null> {
    const fileKey = this.#getFileKey(fileId);
    const serialized = await this.#storage.getItem<{
      metadata: FileMetadata;
      contentId: number[];
      chunkKeys: string[];
    }>(fileKey);

    if (!serialized) return null;

    await Promise.all(
      serialized.chunkKeys.map((k) => this.#storage.removeItem(k)),
    );
    await this.#storage.removeItem(fileKey);

    return serialized.metadata;
  }

  async deleteFile(fileId: File["id"]): Promise<void> {
    const fileMetadata = await this.#deleteFileData(fileId);

    const documentId = fileMetadata?.documentId;
    if (this.#metadataUpdater && documentId) {
      await this.#metadataUpdater.removeFileFromDocument(documentId, fileId);
    }
  }

  async listFileMetadataByDocument(
    documentId: Document["id"],
  ): Promise<FileMetadata[]> {
    if (!this.#documentStorage) return [];
    const metadata =
      await this.#documentStorage.getDocumentMetadata(documentId);
    const fileIds = metadata.files ?? [];
    const files = await Promise.all(fileIds.map((id) => this.getFile(id)));
    return files.filter(Boolean).map((f) => (f as File).metadata);
  }

  async deleteFilesByDocument(documentId: Document["id"]): Promise<void> {
    if (!this.#documentStorage) return;

    await this.#documentStorage.transaction(documentId, async () => {
      const metadata =
        await this.#documentStorage!.getDocumentMetadata(documentId);
      const fileIds = metadata.files ?? [];

      // Delete file data without nested transactions to avoid deadlock
      await Promise.all(fileIds.map((id) => this.#deleteFileData(id)));

      await this.#documentStorage!.writeDocumentMetadata(documentId, {
        ...metadata,
        files: [],
        updatedAt: Date.now(),
      });
    });
  }

  async storeFileFromUpload(uploadResult: FileUploadResult): Promise<void> {
    const expectedChunks =
      uploadResult.progress.metadata.size === 0
        ? 1
        : Math.ceil(uploadResult.progress.metadata.size / CHUNK_SIZE);

    const fileKey = this.#getFileKey(uploadResult.fileId);

    // Store file metadata first
    await this.#storage.setItem(fileKey, {
      metadata: uploadResult.progress.metadata,
      contentId: Array.from(uploadResult.contentId),
      chunkKeys: Array.from(
        { length: expectedChunks },
        (_, i) => `${fileKey}:chunk:${i}`,
      ),
    });

    // Fetch and store chunks incrementally
    for (let i = 0; i < expectedChunks; i++) {
      const chunk = await uploadResult.getChunk(i);
      await this.#storage.setItemRaw(`${fileKey}:chunk:${i}`, chunk);
    }

    const documentId = uploadResult.progress.metadata.documentId;
    if (this.#metadataUpdater && documentId) {
      await this.#metadataUpdater.addFileToDocument(documentId, uploadResult.fileId);
    }
  }
}
