import type { MerkleTree } from "../lib/merkle-tree/merkle-tree";

/**
 * Metadata for a file upload
 */
export interface FileMetadata {
  /**
   * Original filename
   */
  filename: string;
  /**
   * File size in bytes
   */
  size: number;
  /**
   * MIME type
   */
  mimeType: string;
  /**
   * Whether the file is encrypted
   */
  encrypted: boolean;
  /**
   * Timestamp when upload was initiated
   */
  createdAt: number;
}

/**
 * Progress information for an ongoing upload
 */
export interface UploadProgress {
  /**
   * File metadata
   */
  metadata: FileMetadata;
  /**
   * Map of chunk index to chunk data
   */
  chunks: Map<number, Uint8Array>;
  /**
   * Merkle tree for the file
   */
  merkleTree: MerkleTree | null;
  /**
   * Total bytes uploaded so far
   */
  bytesUploaded: number;
  /**
   * Timestamp of last activity
   */
  lastActivity: number;
}

/**
 * Complete file data stored by contentId
 */
export interface FileData {
  /**
   * File metadata
   */
  metadata: FileMetadata;
  /**
   * All chunks in order
   */
  chunks: Uint8Array[];
  /**
   * Merkle tree root hash (contentId)
   */
  contentId: Uint8Array;
}

/**
 * Interface for file storage operations
 */
export abstract class FileStorage {
  /**
   * The type of the storage.
   */
  public readonly type = "file-storage";

  /**
   * Initiate a new file upload session.
   *
   * @param fileId - Client-generated UUID for this upload
   * @param metadata - File metadata
   */
  abstract initiateUpload(
    fileId: string,
    metadata: FileMetadata,
  ): Promise<void>;

  /**
   * Store a chunk for an ongoing upload.
   *
   * @param fileId - Client-generated UUID for this upload
   * @param chunkIndex - Zero-based index of the chunk
   * @param chunkData - Chunk data (64KB)
   * @param proof - Merkle proof for this chunk
   */
  abstract storeChunk(
    fileId: string,
    chunkIndex: number,
    chunkData: Uint8Array,
    proof: Uint8Array[],
  ): Promise<void>;

  /**
   * Get upload progress for a file.
   *
   * @param fileId - Client-generated UUID for this upload
   * @returns Upload progress or null if not found
   */
  abstract getUploadProgress(fileId: string): Promise<UploadProgress | null>;

  /**
   * Complete an upload and store the file by contentId.
   *
   * @param fileId - Client-generated UUID for this upload
   * @param contentId - Merkle root hash (contentId)
   */
  abstract completeUpload(fileId: string, contentId: Uint8Array): Promise<void>;

  /**
   * Get a file by contentId.
   *
   * @param contentId - Merkle root hash (contentId)
   * @returns File data or null if not found
   */
  abstract getFile(contentId: Uint8Array): Promise<FileData | null>;

  /**
   * Clean up expired upload sessions.
   * Should remove uploads that haven't been updated within the timeout window.
   */
  abstract cleanupExpiredUploads(): Promise<void>;
}
