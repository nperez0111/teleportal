import type { FileData, FileMetadata, UploadProgress } from "../file-storage";
import { UnencryptedFileStorage } from "../unencrypted/file-storage";
import { DocumentStorage } from "../document-storage";

/**
 * Default upload timeout in milliseconds (2 hours)
 */
const DEFAULT_UPLOAD_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/**
 * In-memory implementation of FileStorage.
 * Stores files and upload sessions in memory.
 */
export class InMemoryFileStorage extends UnencryptedFileStorage {
  /**
   * Active upload sessions by fileId
   */
  #uploads = new Map<string, UploadProgress>();

  /**
   * Completed files by contentId (hex encoded)
   */
  #files = new Map<string, FileData>();

  /**
   * Upload timeout in milliseconds
   */
  #uploadTimeoutMs: number;

  constructor(
    uploadTimeoutMs: number = DEFAULT_UPLOAD_TIMEOUT_MS,
    documentStorage?: DocumentStorage,
  ) {
    super(documentStorage);
    this.#uploadTimeoutMs = uploadTimeoutMs;
  }

  protected async createUploadSession(
    fileId: string,
    metadata: FileMetadata,
  ): Promise<void> {
    this.#uploads.set(fileId, {
      metadata,
      chunks: new Map(),
      merkleTree: null,
      bytesUploaded: 0,
      lastActivity: Date.now(),
    });
  }

  protected async getUploadSession(
    fileId: string,
  ): Promise<UploadProgress | null> {
    return this.#uploads.get(fileId) ?? null;
  }

  protected async deleteUploadSession(fileId: string): Promise<void> {
    this.#uploads.delete(fileId);
  }

  protected async storeChunkForUpload(
    fileId: string,
    chunkIndex: number,
    chunkData: Uint8Array,
  ): Promise<void> {
    const upload = this.#uploads.get(fileId);
    if (!upload) {
      throw new Error(`Upload session ${fileId} not found`);
    }
    upload.chunks.set(chunkIndex, chunkData);
  }

  protected async getChunksForUpload(
    fileId: string,
  ): Promise<Uint8Array[] | null> {
    const upload = this.#uploads.get(fileId);
    if (!upload) {
      return null;
    }

    // Get all chunks in order
    const chunkIndices = Array.from(upload.chunks.keys()).sort((a, b) => a - b);
    return chunkIndices.map((index) => upload.chunks.get(index)!);
  }

  protected async updateUploadSession(
    fileId: string,
    lastActivity: number,
    bytesUploaded: number,
  ): Promise<void> {
    const upload = this.#uploads.get(fileId);
    if (!upload) {
      throw new Error(`Upload session ${fileId} not found`);
    }
    upload.lastActivity = lastActivity;
    upload.bytesUploaded = bytesUploaded;
  }

  protected async storeFile(
    contentId: Uint8Array,
    fileData: FileData,
  ): Promise<void> {
    const contentIdKey = this.#contentIdToKey(contentId);
    this.#files.set(contentIdKey, fileData);
  }

  protected async getStoredFile(
    contentId: Uint8Array,
  ): Promise<FileData | null> {
    const contentIdKey = this.#contentIdToKey(contentId);
    return this.#files.get(contentIdKey) ?? null;
  }

  public async deleteFile(contentId: Uint8Array): Promise<void> {
    const contentIdKey = this.#contentIdToKey(contentId);
    this.#files.delete(contentIdKey);
  }

  protected async getAllUploadSessions(): Promise<
    Array<[string, UploadProgress]>
  > {
    return Array.from(this.#uploads.entries());
  }

  protected getUploadTimeoutMs(): number {
    return this.#uploadTimeoutMs;
  }

  /**
   * Convert contentId (Uint8Array) to a string key for Map storage
   */
  #contentIdToKey(contentId: Uint8Array): string {
    return Array.from(contentId)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
}
