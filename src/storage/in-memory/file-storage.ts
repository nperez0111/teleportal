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
import type { InMemoryTemporaryUploadStorage } from "./temporary-upload-storage";

/**
 * In-memory implementation of {@link FileStorage}.
 *
 * @note Upload session management is handled by a {@link TemporaryUploadStorage}
 * implementation (see {@link InMemoryTemporaryUploadStorage}).
 */
export class InMemoryFileStorage implements FileStorage {
  readonly type = "file-storage" as const;

  temporaryUploadStorage?: TemporaryUploadStorage;
  #metadataUpdater?: DocumentMetadataUpdater;
  #documentStorage?: DocumentStorage;
  #files = new Map<string, File>();

  constructor(options?: {
    metadataUpdater?: DocumentMetadataUpdater;
    documentStorage?: DocumentStorage;
    temporaryUploadStorage?: TemporaryUploadStorage;
  }) {
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

  /**
   * Store a completed file (helper for temporary upload storage composition).
   * This is intentionally not part of the public `FileStorage` interface.
   */
  async storeFile(file: File): Promise<void> {
    this.#files.set(file.id, file);

    const documentId = file.metadata.documentId;
    if (this.#metadataUpdater && documentId) {
      await this.#metadataUpdater.addFileToDocument(documentId, file.id);
    }
  }

  async getFile(fileId: File["id"]): Promise<File | null> {
    return this.#files.get(fileId) ?? null;
  }

  /**
   * Internal method to delete file data without updating document metadata.
   * This avoids transaction deadlocks when called from within a transaction.
   */
  #deleteFileData(fileId: File["id"]): File | null {
    const file = this.#files.get(fileId);
    this.#files.delete(fileId);
    return file ?? null;
  }

  async deleteFile(fileId: File["id"]): Promise<void> {
    const file = this.#deleteFileData(fileId);

    const documentId = file?.metadata.documentId;
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
      for (const id of fileIds) this.#deleteFileData(id);

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

    // Fetch all chunks incrementally and store them
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < expectedChunks; i++) {
      const chunk = await uploadResult.getChunk(i);
      chunks.push(chunk);
    }

    const file: File = {
      id: uploadResult.fileId,
      metadata: uploadResult.progress.metadata,
      chunks,
      contentId: uploadResult.contentId,
    };

    await this.storeFile(file);
  }
}
