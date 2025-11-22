import type { Storage } from "unstorage";
import type { FileData, FileMetadata, UploadProgress } from "../file-storage";
import { UnencryptedFileStorage } from "../unencrypted/file-storage";
import { toBase64 } from "lib0/buffer";
import { DocumentStorage } from "../document-storage";

/**
 * Default upload timeout in milliseconds (24 hours)
 */
const DEFAULT_UPLOAD_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * Unstorage-based file storage implementation.
 * Stores files and upload sessions using unstorage.
 */
export class UnstorageFileStorage extends UnencryptedFileStorage {
  private readonly storage: Storage;
  private readonly uploadTimeoutMs: number;
  private readonly keyPrefix: string;

  constructor(
    storage: Storage,
    options?: {
      uploadTimeoutMs?: number;
      keyPrefix?: string;
      documentStorage?: DocumentStorage;
    },
  ) {
    super(options?.documentStorage);
    this.storage = storage;
    this.uploadTimeoutMs =
      options?.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
    this.keyPrefix = options?.keyPrefix ?? "file";
  }

  /**
   * Get the storage key for an upload session metadata
   */
  #getUploadSessionKey(uploadId: string): string {
    return `${this.keyPrefix}:upload:${uploadId}`;
  }

  /**
   * Get the storage key for a chunk
   */
  #getChunkKey(uploadId: string, chunkIndex: number): string {
    return `${this.keyPrefix}:upload:${uploadId}:chunk:${chunkIndex}`;
  }

  /**
   * Get the storage key for a completed file
   */
  #getFileKey(contentId: Uint8Array): string {
    return `${this.keyPrefix}:file:${toBase64(contentId)}`;
  }

  protected async createUploadSession(
    uploadId: string,
    metadata: FileMetadata,
  ): Promise<void> {
    const sessionKey = this.#getUploadSessionKey(uploadId);
    const session: UploadProgress = {
      metadata,
      chunks: new Map(),
      merkleTree: null,
      bytesUploaded: 0,
      lastActivity: Date.now(),
    };

    // Store session metadata (without chunks map, which we'll store separately)
    await this.storage.setItem(sessionKey, {
      metadata: session.metadata,
      bytesUploaded: session.bytesUploaded,
      lastActivity: session.lastActivity,
    });
  }

  protected async getUploadSession(
    uploadId: string,
  ): Promise<UploadProgress | null> {
    const sessionKey = this.#getUploadSessionKey(uploadId);
    const sessionData = await this.storage.getItem<{
      metadata: FileMetadata;
      bytesUploaded: number;
      lastActivity: number;
    }>(sessionKey);

    if (!sessionData) {
      return null;
    }

    // Reconstruct chunks map by reading all chunk keys
    const chunks = new Map<number, Uint8Array>();
    const chunkKeys = await this.storage.getKeys(
      `${this.keyPrefix}:upload:${uploadId}:chunk:`,
    );

    for (const chunkKey of chunkKeys) {
      const chunkIndex = parseInt(chunkKey.split(":chunk:")[1] ?? "-1", 10);
      if (chunkIndex >= 0) {
        const chunkData = await this.storage.getItemRaw<Uint8Array>(chunkKey);
        if (chunkData) {
          chunks.set(chunkIndex, chunkData);
        }
      }
    }

    return {
      metadata: sessionData.metadata,
      chunks,
      merkleTree: null,
      bytesUploaded: sessionData.bytesUploaded,
      lastActivity: sessionData.lastActivity,
    };
  }

  protected async deleteUploadSession(uploadId: string): Promise<void> {
    const sessionKey = this.#getUploadSessionKey(uploadId);

    // Delete all chunks first
    const chunkKeys = await this.storage.getKeys(
      `${this.keyPrefix}:upload:${uploadId}:chunk:`,
    );
    await Promise.all(chunkKeys.map((key) => this.storage.removeItem(key)));

    // Delete session metadata
    await this.storage.removeItem(sessionKey);
  }

  protected async storeChunkForUpload(
    uploadId: string,
    chunkIndex: number,
    chunkData: Uint8Array,
  ): Promise<void> {
    const chunkKey = this.#getChunkKey(uploadId, chunkIndex);
    await this.storage.setItemRaw(chunkKey, chunkData);
  }

  protected async getChunksForUpload(
    uploadId: string,
  ): Promise<Uint8Array[] | null> {
    const session = await this.getUploadSession(uploadId);
    if (!session) {
      return null;
    }

    // Get all chunks in order
    const chunkIndices = Array.from(session.chunks.keys()).sort(
      (a, b) => a - b,
    );
    return chunkIndices.map((index) => session.chunks.get(index)!);
  }

  protected async updateUploadSession(
    uploadId: string,
    lastActivity: number,
    bytesUploaded: number,
  ): Promise<void> {
    const sessionKey = this.#getUploadSessionKey(uploadId);
    const sessionData = await this.storage.getItem<{
      metadata: FileMetadata;
      bytesUploaded: number;
      lastActivity: number;
    }>(sessionKey);

    if (!sessionData) {
      throw new Error(`Upload session ${uploadId} not found`);
    }

    await this.storage.setItem(sessionKey, {
      ...sessionData,
      lastActivity,
      bytesUploaded,
    });
  }

  protected async storeFile(
    contentId: Uint8Array,
    fileData: FileData,
  ): Promise<void> {
    const fileKey = this.#getFileKey(contentId);
    // Serialize FileData preserving Uint8Arrays
    // Store metadata and chunks separately to preserve Uint8Array types
    const serialized = {
      metadata: fileData.metadata,
      contentId: Array.from(fileData.contentId),
      chunkKeys: fileData.chunks.map((_, index) => `${fileKey}:chunk:${index}`),
    };

    // Store metadata
    await this.storage.setItem(fileKey, serialized);

    // Store chunks individually to preserve Uint8Array type
    await Promise.all(
      fileData.chunks.map((chunk, index) =>
        this.storage.setItemRaw(`${fileKey}:chunk:${index}`, chunk),
      ),
    );
  }

  protected async getStoredFile(
    contentId: Uint8Array,
  ): Promise<FileData | null> {
    const fileKey = this.#getFileKey(contentId);
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
      metadata: serialized.metadata,
      chunks: validChunks,
      contentId: new Uint8Array(serialized.contentId),
    };
  }

  public async deleteFile(contentId: Uint8Array): Promise<void> {
    const fileKey = this.#getFileKey(contentId);
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

  protected async getAllUploadSessions(): Promise<
    Array<[string, UploadProgress]>
  > {
    const uploadKeys = await this.storage.getKeys(`${this.keyPrefix}:upload:`);

    const sessions: Array<[string, UploadProgress]> = [];

    for (const key of uploadKeys) {
      // Skip chunk keys, only process session metadata keys
      if (key.includes(":chunk:")) {
        continue;
      }

      // Extract fileId from key (format: prefix:upload:fileId)
      const fileId = key.split(`${this.keyPrefix}:upload:`)[1];
      if (fileId) {
        const session = await this.getUploadSession(fileId);
        if (session) {
          sessions.push([fileId, session]);
        }
      }
    }

    return sessions;
  }

  protected getUploadTimeoutMs(): number {
    return this.uploadTimeoutMs;
  }
}
