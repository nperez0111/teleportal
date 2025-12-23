import { CHUNK_SIZE } from "../../lib/merkle-tree/merkle-tree";
import type {
  Document,
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
  #documentStorage?: DocumentStorage;
  #files = new Map<string, File>();

  constructor(options?: {
    documentStorage?: DocumentStorage;
    temporaryUploadStorage?: TemporaryUploadStorage;
  }) {
    this.#documentStorage = options?.documentStorage;
    this.temporaryUploadStorage = options?.temporaryUploadStorage;
  }

  /**
   * Store a completed file (helper for temporary upload storage composition).
   * This is intentionally not part of the public `FileStorage` interface.
   */
  async storeFile(file: File): Promise<void> {
    this.#files.set(file.id, file);

    const documentId = file.metadata.documentId;
    if (!this.#documentStorage || !documentId) return;

    await this.#documentStorage.transaction(documentId, async () => {
      const metadata =
        await this.#documentStorage!.getDocumentMetadata(documentId);
      const files = Array.from(new Set([...(metadata.files ?? []), file.id]));
      await this.#documentStorage!.writeDocumentMetadata(documentId, {
        ...metadata,
        files,
        updatedAt: Date.now(),
      });
    });
  }

  async getFile(fileId: File["id"]): Promise<File | null> {
    return this.#files.get(fileId) ?? null;
  }

  async deleteFile(fileId: File["id"]): Promise<void> {
    const file = this.#files.get(fileId);
    this.#files.delete(fileId);

    const documentId = file?.metadata.documentId;
    if (!this.#documentStorage || !documentId) return;

    await this.#documentStorage.transaction(documentId, async () => {
      const metadata =
        await this.#documentStorage!.getDocumentMetadata(documentId);
      const files = (metadata.files ?? []).filter((id) => id !== fileId);
      await this.#documentStorage!.writeDocumentMetadata(documentId, {
        ...metadata,
        files,
        updatedAt: Date.now(),
      });
    });
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

      await Promise.all(fileIds.map((id) => this.deleteFile(id)));

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
