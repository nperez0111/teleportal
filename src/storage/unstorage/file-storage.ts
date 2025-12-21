import type { Storage } from "unstorage";
import type {
  Document,
  DocumentStorage,
  File,
  FileMetadata,
  FileStorage,
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
  #documentStorage?: DocumentStorage;

  constructor(
    storage: Storage,
    options?: {
      keyPrefix?: string;
      documentStorage?: DocumentStorage;
      temporaryUploadStorage?: TemporaryUploadStorage;
    },
  ) {
    this.#storage = storage;
    this.#keyPrefix = options?.keyPrefix ?? "file";
    this.#documentStorage = options?.documentStorage;
    this.temporaryUploadStorage = options?.temporaryUploadStorage;
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
    if (!this.#documentStorage || !documentId) return;

    await this.#documentStorage.transaction(documentId, async () => {
      const metadata = await this.#documentStorage!.getDocumentMetadata(documentId);
      const files = Array.from(new Set([...(metadata.files ?? []), file.id]));
      await this.#documentStorage!.writeDocumentMetadata(documentId, {
        ...metadata,
        files,
        updatedAt: Date.now(),
      });
    });
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
    const validChunks = chunks.filter(
      (c): c is Uint8Array => c !== null,
    );

    return {
      id: fileId,
      metadata: serialized.metadata,
      chunks: validChunks,
      contentId: new Uint8Array(serialized.contentId),
    };
  }

  async deleteFile(fileId: File["id"]): Promise<void> {
    const fileKey = this.#getFileKey(fileId);
    const serialized = await this.#storage.getItem<{
      metadata: FileMetadata;
      contentId: number[];
      chunkKeys: string[];
    }>(fileKey);

    if (!serialized) return;

    await Promise.all(serialized.chunkKeys.map((k) => this.#storage.removeItem(k)));
    await this.#storage.removeItem(fileKey);

    const documentId = serialized.metadata.documentId;
    if (!this.#documentStorage || !documentId) return;

    await this.#documentStorage.transaction(documentId, async () => {
      const metadata = await this.#documentStorage!.getDocumentMetadata(documentId);
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
    const metadata = await this.#documentStorage.getDocumentMetadata(documentId);
    const fileIds = metadata.files ?? [];
    const files = await Promise.all(fileIds.map((id) => this.getFile(id)));
    return files.filter(Boolean).map((f) => (f as File).metadata);
  }

  async deleteFilesByDocument(documentId: Document["id"]): Promise<void> {
    if (!this.#documentStorage) return;

    await this.#documentStorage.transaction(documentId, async () => {
      const metadata = await this.#documentStorage!.getDocumentMetadata(documentId);
      const fileIds = metadata.files ?? [];

      await Promise.all(fileIds.map((id) => this.deleteFile(id)));

      await this.#documentStorage!.writeDocumentMetadata(documentId, {
        ...metadata,
        files: [],
        updatedAt: Date.now(),
      });
    });
  }
}
