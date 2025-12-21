import type { Storage } from "unstorage";
import type {
  FileMetadata,
  TemporaryUploadStorage,
  UploadProgress,
  File,
} from "../types";

const DEFAULT_UPLOAD_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export class UnstorageTemporaryUploadStorage implements TemporaryUploadStorage {
  readonly type = "temporary-upload-storage";
  private readonly storage: Storage;
  private readonly uploadTimeoutMs: number;
  private readonly keyPrefix: string;

  constructor(
    storage: Storage,
    options?: {
      uploadTimeoutMs?: number;
      keyPrefix?: string;
    },
  ) {
    this.storage = storage;
    this.uploadTimeoutMs =
      options?.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
    this.keyPrefix = options?.keyPrefix ?? "upload";
  }

  /**
   * Get the storage key for an upload session metadata
   */
  #getUploadSessionKey(uploadId: string): string {
    return `${this.keyPrefix}:${uploadId}`;
  }

  /**
   * Get the storage key for a chunk
   */
  #getChunkKey(uploadId: string, chunkIndex: number): string {
    return `${this.keyPrefix}:${uploadId}:chunk:${chunkIndex}`;
  }

  async beginUpload(uploadId: string, metadata: FileMetadata): Promise<void> {
    const sessionKey = this.#getUploadSessionKey(uploadId);
    const sessionData = {
      metadata,
      lastActivity: Date.now(),
    };
    await this.storage.setItem(sessionKey, sessionData);
  }

  async storeChunk(
    uploadId: string,
    chunkIndex: number,
    chunkData: Uint8Array,
    proof: Uint8Array[],
  ): Promise<void> {
    const sessionKey = this.#getUploadSessionKey(uploadId);
    const sessionData = await this.storage.getItem<{
      metadata: FileMetadata;
      lastActivity: number;
    }>(sessionKey);

    if (!sessionData) {
      throw new Error(`Upload session ${uploadId} not found`);
    }

    const chunkKey = this.#getChunkKey(uploadId, chunkIndex);
    await this.storage.setItemRaw(chunkKey, chunkData);

    // Update last activity
    sessionData.lastActivity = Date.now();
    await this.storage.setItem(sessionKey, sessionData);
  }

  async getUploadProgress(uploadId: string): Promise<UploadProgress | null> {
    const sessionKey = this.#getUploadSessionKey(uploadId);
    const sessionData = await this.storage.getItem<{
      metadata: FileMetadata;
      lastActivity: number;
    }>(sessionKey);

    if (!sessionData) {
      return null;
    }

    // Reconstruct chunks map and calculate bytes uploaded
    const chunks = new Map<number, boolean>();
    const chunkKeys = await this.storage.getKeys(
      `${this.keyPrefix}:${uploadId}:chunk:`,
    );

    let bytesUploaded = 0;

    for (const chunkKey of chunkKeys) {
      const chunkIndex = parseInt(chunkKey.split(":chunk:")[1] ?? "-1", 10);
      if (chunkIndex >= 0) {
        chunks.set(chunkIndex, true);
        // Note: this is expensive as it reads all chunks. 
        // Optimized implementation would store chunk sizes in metadata or auxiliary key.
        const chunkData = await this.storage.getItemRaw<Uint8Array>(chunkKey);
        if (chunkData) {
          bytesUploaded += chunkData.length;
        }
      }
    }

    return {
      metadata: sessionData.metadata,
      chunks,
      merkleTree: null,
      bytesUploaded,
      lastActivity: sessionData.lastActivity,
    };
  }

  async completeUpload(
    uploadId: string,
    fileId: File["id"],
  ): Promise<{
    progress: UploadProgress;
    getChunk: (chunkIndex: number) => Promise<Uint8Array>;
  }> {
    const progress = await this.getUploadProgress(uploadId);
    if (!progress) {
      throw new Error(`Upload session ${uploadId} not found`);
    }

    return {
      progress,
      getChunk: async (chunkIndex: number) => {
        const chunkKey = this.#getChunkKey(uploadId, chunkIndex);
        const data = await this.storage.getItemRaw<Uint8Array>(chunkKey);
        if (!data) {
          throw new Error(
            `Chunk ${chunkIndex} not found for upload ${uploadId}`,
          );
        }
        return data;
      },
    };
  }

  async cleanupExpiredUploads(): Promise<void> {
    const keys = await this.storage.getKeys(`${this.keyPrefix}:`);
    const now = Date.now();

    for (const key of keys) {
      // Skip chunk keys, only process session keys
      if (key.includes(":chunk:")) {
        continue;
      }

      const sessionData = await this.storage.getItem<{ lastActivity: number }>(
        key,
      );
      if (sessionData && sessionData.lastActivity) {
        if (now - sessionData.lastActivity > this.uploadTimeoutMs) {
          // Extract uploadId from key
          // Key format: prefix:uploadId
          const uploadId = key.substring(this.keyPrefix.length + 1);

          // Delete session
          await this.storage.removeItem(key);

          // Delete chunks
          const chunkKeys = await this.storage.getKeys(`${key}:chunk:`);
          for (const ck of chunkKeys) {
            await this.storage.removeItem(ck);
          }
        }
      }
    }
  }
}
