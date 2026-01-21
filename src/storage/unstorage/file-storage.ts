import { CHUNK_SIZE } from "teleportal/merkle-tree";
import type { Storage } from "unstorage";
import type {
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

  constructor(
    storage: Storage,
    options?: {
      keyPrefix?: string;
      temporaryUploadStorage?: TemporaryUploadStorage;
    },
  ) {
    this.#storage = storage;
    this.#keyPrefix = options?.keyPrefix ?? "file";
    this.temporaryUploadStorage = options?.temporaryUploadStorage;
  }

  #getFileKey(fileId: string): string {
    return `${this.#keyPrefix}:file:${fileId}`;
  }

  #getChunkKey(fileKey: string, chunkIndex: number): string {
    return `${fileKey}:chunk:${chunkIndex}`;
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
      chunkKeys: file.chunks.map((_, index) =>
        this.#getChunkKey(fileKey, index),
      ),
    });

    await Promise.all(
      file.chunks.map((chunk, index) =>
        this.#storage.setItemRaw(this.#getChunkKey(fileKey, index), chunk),
      ),
    );
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
    await this.#deleteFileData(fileId);
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
      chunkKeys: Array.from({ length: expectedChunks }, (_, i) =>
        this.#getChunkKey(fileKey, i),
      ),
    });

    // Fetch and store chunks incrementally
    for (let i = 0; i < expectedChunks; i++) {
      const chunk = await uploadResult.getChunk(i);
      await this.#storage.setItemRaw(this.#getChunkKey(fileKey, i), chunk);
    }
  }
}
