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
   * Last modified timestamp of the file
   */
  lastModified: number;
  /**
   * The document ID associated with this file
   */
  documentId: string;
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
 * Interface for upload storage operations (temporary storage)
 */
export abstract class UploadStorage {
  /**
   * Initiate a new file upload session.
   *
   * @param uploadId - Client-generated UUID for this upload
   * @param metadata - File metadata
   */
  abstract initiateUpload(
    uploadId: string,
    metadata: FileMetadata,
  ): Promise<void>;

  /**
   * Store a chunk for an ongoing upload.
   *
   * @param uploadId - Client-generated UUID for this upload
   * @param chunkIndex - Zero-based index of the chunk
   * @param chunkData - Chunk data (64KB)
   * @param proof - Merkle proof for this chunk
   */
  abstract storeChunk(
    uploadId: string,
    chunkIndex: number,
    chunkData: Uint8Array,
    proof: Uint8Array[],
  ): Promise<void>;

  /**
   * Get upload progress for a file.
   *
   * @param uploadId - Client-generated UUID for this upload
   * @returns Upload progress or null if not found
   */
  abstract getUploadProgress(uploadId: string): Promise<UploadProgress | null>;

  /**
   * Complete an upload and store the file by contentId.
   *
   * @param uploadId - Client-generated UUID for this upload
   * @param contentId - Merkle root hash (contentId)
   */
  abstract completeUpload(
    uploadId: string,
    contentId: Uint8Array,
  ): Promise<void>;

  /**
   * Clean up expired upload sessions.
   * Should remove uploads that haven't been updated within the timeout window.
   */
  abstract cleanupExpiredUploads(): Promise<void>;
}

/**
 * Interface for file storage operations (cold storage)
 */
export abstract class FileStorage extends UploadStorage {
  /**
   * The type of the storage.
   */
  public readonly type = "file-storage";

  /**
   * Get a file by contentId.
   *
   * @param contentId - Merkle root hash (contentId)
   * @returns File data or null if not found
   */
  abstract getFile(contentId: Uint8Array): Promise<FileData | null>;

  // TODO when creating a milestone, we need to also mark all the files as part of the milestone.
  // If a previous milestone contains a file, then we should not actually delete it, but rather remove it from the metadata document.
  // This way, we can still access the file from the previous milestone, but it will not be part of the current milestone.
  /**
   * Delete a file by contentId.
   *
   * @param contentId - Merkle root hash (contentId)
   */
  abstract deleteFile(contentId: Uint8Array): Promise<void>;

  /**
   * Get all files associated with a document.
   *
   * @param documentId - The document ID
   * @returns Array of file data
   */
  abstract getFilesByDocument(documentId: string): Promise<FileData[]>;

  /**
   * Delete all files associated with a document.
   *
   * @param documentId - The document ID
   */
  abstract deleteFilesByDocument(documentId: string): Promise<void>;
}
