import type { Storage } from "unstorage";
import type { File, FileMetadata, DocumentStorage, TemporaryUploadStorage } from "../types";
import { UnencryptedFileStorage } from "../unencrypted/file-storage";

/**
 * Unstorage-based file storage implementation.
 * Stores files using unstorage.
 */
export class UnstorageFileStorage extends UnencryptedFileStorage {
  private readonly storage: Storage;
  private readonly keyPrefix: string;

  constructor(
    storage: Storage,
    options?: {
      keyPrefix?: string;
      documentStorage?: DocumentStorage;
      temporaryUploadStorage?: TemporaryUploadStorage;
    },
  ) {
    super(options?.documentStorage, options?.temporaryUploadStorage);
    this.storage = storage;
    this.keyPrefix = options?.keyPrefix ?? "file";
  }

  /**
   * Get the storage key for a completed file
   */
  #getFileKey(fileId: string): string {
    return `${this.keyPrefix}:${fileId}`;
  }

  async storeFile(file: File): Promise<void> {
    const fileKey = this.#getFileKey(file.id);

    // Store metadata and chunks separately to preserve Uint8Array types
    const serialized = {
      metadata: file.metadata,
      contentId: Array.from(file.contentId),
      chunkKeys: file.chunks.map((_, index) => `${fileKey}:chunk:${index}`),
    };

    // Store metadata
    await this.storage.setItem(fileKey, serialized);

    // Store chunks individually to preserve Uint8Array type
    await Promise.all(
      file.chunks.map((chunk, index) =>
        this.storage.setItemRaw(`${fileKey}:chunk:${index}`, chunk),
      ),
    );
  }

  async getFile(fileId: string): Promise<File | null> {
    const fileKey = this.#getFileKey(fileId);
    const serialized = await this.storage.getItem<{
      metadata: FileMetadata;
      contentId: number[];
      chunkKeys: string[];
    }>(fileKey);

    if (!serialized) {
      return null;
    }

    // Retrieve chunks
    const chunks = await Promise.all(
      serialized.chunkKeys.map((chunkKey) =>
        this.storage.getItemRaw<Uint8Array>(chunkKey),
      ),
    );

    // Filter out any null chunks
    const validChunks = chunks.filter(
      (chunk): chunk is Uint8Array => chunk !== null,
    );

    return {
      id: fileId,
      metadata: serialized.metadata,
      chunks: validChunks,
      contentId: new Uint8Array(serialized.contentId),
    };
  }

  async deleteFile(fileId: string): Promise<void> {
    const fileKey = this.#getFileKey(fileId);
    const serialized = await this.storage.getItem<{
      metadata: FileMetadata;
      contentId: number[];
      chunkKeys: string[];
    }>(fileKey);

    if (!serialized) {
      return;
    }

    // Delete all chunks
    await Promise.all(
      serialized.chunkKeys.map((key) => this.storage.removeItem(key)),
    );

    // Delete file metadata
    await this.storage.removeItem(fileKey);
  }

  protected async getFileMetadata(
    fileId: string,
  ): Promise<FileMetadata | null> {
    const fileKey = this.#getFileKey(fileId);
    const serialized = await this.storage.getItem<{
      metadata: FileMetadata;
    }>(fileKey);

    return serialized ? serialized.metadata : null;
  }
}
