import { buildMerkleTree, CHUNK_SIZE } from "../../lib/merkle-tree/merkle-tree";
import {
  FileStorage,
  type FileData,
  type FileMetadata,
  type UploadProgress,
} from "../file-storage";

/**
 * Base class for unencrypted file storage implementations.
 *
 * This provides a simpler interface for unencrypted files, where the file data
 * is stored without encryption. It abstracts away merkle tree operations and
 * provides default implementations for the FileStorage interface methods.
 *
 * Concrete implementations should extend this class and provide implementations
 * for the abstract storage methods.
 */
export abstract class UnencryptedFileStorage extends FileStorage {
  public encrypted = false;

  /**
   * Create a new upload session.
   *
   * @param fileId - Client-generated UUID for this upload
   * @param metadata - File metadata
   */
  protected abstract createUploadSession(
    fileId: string,
    metadata: FileMetadata,
  ): Promise<void>;

  /**
   * Get an upload session by fileId.
   *
   * @param fileId - Client-generated UUID for this upload
   * @returns Upload progress or null if not found
   */
  protected abstract getUploadSession(
    fileId: string,
  ): Promise<UploadProgress | null>;

  /**
   * Delete an upload session.
   *
   * @param fileId - Client-generated UUID for this upload
   */
  protected abstract deleteUploadSession(fileId: string): Promise<void>;

  /**
   * Store a chunk for an upload session.
   *
   * @param fileId - Client-generated UUID for this upload
   * @param chunkIndex - Zero-based index of the chunk
   * @param chunkData - Chunk data
   */
  protected abstract storeChunkForUpload(
    fileId: string,
    chunkIndex: number,
    chunkData: Uint8Array,
  ): Promise<void>;

  /**
   * Get all chunks for an upload session in order.
   *
   * @param fileId - Client-generated UUID for this upload
   * @returns Array of chunks in order, or null if upload not found
   */
  protected abstract getChunksForUpload(
    fileId: string,
  ): Promise<Uint8Array[] | null>;

  /**
   * Update the upload session with new activity timestamp and bytes uploaded.
   *
   * @param fileId - Client-generated UUID for this upload
   * @param lastActivity - Timestamp of last activity
   * @param bytesUploaded - Total bytes uploaded so far
   */
  protected abstract updateUploadSession(
    fileId: string,
    lastActivity: number,
    bytesUploaded: number,
  ): Promise<void>;

  /**
   * Store a completed file by contentId.
   *
   * @param contentId - Merkle root hash (contentId)
   * @param fileData - Complete file data
   */
  protected abstract storeFile(
    contentId: Uint8Array,
    fileData: FileData,
  ): Promise<void>;

  /**
   * Get a stored file by contentId.
   *
   * @param contentId - Merkle root hash (contentId)
   * @returns File data or null if not found
   */
  protected abstract getStoredFile(
    contentId: Uint8Array,
  ): Promise<FileData | null>;

  /**
   * Get all upload sessions (for cleanup operations).
   *
   * @returns Array of tuples [fileId, uploadProgress]
   */
  protected abstract getAllUploadSessions(): Promise<
    Array<[string, UploadProgress]>
  >;

  /**
   * Default implementation that creates an upload session.
   */
  async initiateUpload(
    uploadId: string,
    metadata: FileMetadata,
  ): Promise<void> {
    const existing = await this.getUploadSession(uploadId);
    if (existing) {
      throw new Error(`Upload session ${uploadId} already exists`);
    }

    await this.createUploadSession(uploadId, {
      ...metadata,
      lastModified: metadata.lastModified || Date.now(),
    });
  }

  /**
   * Default implementation that stores a chunk and updates activity.
   */
  async storeChunk(
    uploadId: string,
    chunkIndex: number,
    chunkData: Uint8Array,
    proof: Uint8Array[],
  ): Promise<void> {
    const upload = await this.getUploadSession(uploadId);
    if (!upload) {
      throw new Error(`Upload session ${uploadId} not found`);
    }

    // Store the chunk
    await this.storeChunkForUpload(uploadId, chunkIndex, chunkData);

    // Calculate new bytesUploaded from all chunks
    const chunks = await this.getChunksForUpload(uploadId);
    const bytesUploaded = chunks
      ? chunks.reduce((sum, chunk) => sum + chunk.length, 0)
      : upload.bytesUploaded + chunkData.length;

    // Update session with new activity and bytes uploaded
    await this.updateUploadSession(uploadId, Date.now(), bytesUploaded);
  }

  /**
   * Default implementation that returns upload progress.
   */
  async getUploadProgress(uploadId: string): Promise<UploadProgress | null> {
    return await this.getUploadSession(uploadId);
  }

  /**
   * Default implementation that completes an upload with merkle tree verification.
   */
  async completeUpload(uploadId: string, contentId: Uint8Array): Promise<void> {
    const upload = await this.getUploadSession(uploadId);
    if (!upload) {
      throw new Error(`Upload session ${uploadId} not found`);
    }

    // Get chunks for verification
    const chunks = await this.getChunksForUpload(uploadId);
    if (!chunks || chunks.length === 0) {
      throw new Error(`No chunks found for file ${uploadId}`);
    }

    // Determine expected number of chunks
    // Files under 64KB should always expect exactly 1 chunk, and 0-byte files should also expect 1 chunk
    const expectedChunks =
      upload.metadata.size === 0
        ? 1
        : Math.ceil(upload.metadata.size / CHUNK_SIZE);

    // Verify we have all chunks from 0 to expectedChunks-1
    // Check for missing chunks individually by examining the upload session
    for (let i = 0; i < expectedChunks; i++) {
      if (!upload.chunks.has(i)) {
        throw new Error(`Missing chunk ${i} for file ${uploadId}`);
      }
    }

    // Verify total size matches
    const totalSize = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (totalSize !== upload.metadata.size) {
      throw new Error(
        `Size mismatch for file ${uploadId}. Expected ${upload.metadata.size}, got ${totalSize}`,
      );
    }

    // Build merkle tree from all chunks
    const merkleTree = buildMerkleTree(chunks);

    // Verify root hash matches contentId
    const rootHash = merkleTree.nodes[merkleTree.nodes.length - 1].hash;
    if (
      rootHash.length !== contentId.length ||
      !rootHash.every((byte, i) => byte === contentId[i])
    ) {
      throw new Error(
        `Merkle root hash mismatch for file ${uploadId}. Expected ${Array.from(
          contentId,
        )
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("")}, got ${Array.from(rootHash)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("")}`,
      );
    }

    // Store file by contentId
    await this.storeFile(contentId, {
      metadata: upload.metadata,
      chunks,
      contentId,
    });

    // Remove upload session
    await this.deleteUploadSession(uploadId);
  }

  /**
   * Default implementation that retrieves a file by contentId.
   */
  async getFile(contentId: Uint8Array): Promise<FileData | null> {
    return await this.getStoredFile(contentId);
  }

  /**
   * Default implementation that cleans up expired upload sessions.
   * Subclasses should override getUploadTimeoutMs() to customize the timeout.
   */
  async cleanupExpiredUploads(): Promise<void> {
    const timeoutMs = this.getUploadTimeoutMs();
    const now = Date.now();
    const sessions = await this.getAllUploadSessions();

    for (const [fileId, upload] of sessions) {
      if (now - upload.lastActivity > timeoutMs) {
        await this.deleteUploadSession(fileId);
      }
    }
  }

  /**
   * Get the upload timeout in milliseconds.
   * Default is 24 hours. Subclasses can override to customize.
   *
   * @returns Upload timeout in milliseconds
   */
  protected getUploadTimeoutMs(): number {
    return 24 * 60 * 60 * 1000; // 24 hours
  }
}
