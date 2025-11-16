import { toBase64 } from "lib0/buffer";
import type {
  buildMerkleTree,
  MerkleTree,
  verifyMerkleProof,
} from "../lib/protocol/file-upload";

/**
 * Metadata for a file upload.
 */
export interface FileMetadata {
  filename: string;
  size: number;
  mimeType: string;
  encrypted: boolean;
  createdAt: number;
}

/**
 * Progress information for an upload.
 */
export interface UploadProgress {
  fileId: string;
  metadata: FileMetadata;
  chunks: Map<number, Uint8Array>;
  merkleTree?: MerkleTree;
  bytesUploaded: number;
  totalChunks: number;
  lastChunkIndex: number;
}

/**
 * Complete file data stored by contentId.
 */
export interface FileData {
  contentId: Uint8Array; // Merkle root hash
  metadata: FileMetadata;
  chunks: Uint8Array[];
  merkleTree: MerkleTree;
}

/**
 * Interface for file storage operations.
 */
export interface FileStorage {
  /**
   * Initiate an upload session for a file.
   * @param fileId - The client UUID for this file
   * @param metadata - File metadata
   */
  initiateUpload(fileId: string, metadata: FileMetadata): Promise<void>;

  /**
   * Store a chunk for an upload.
   * @param fileId - The client UUID for this file
   * @param chunkIndex - The index of the chunk
   * @param chunkData - The chunk data (64KB)
   * @param proof - Merkle proof for this chunk
   */
  storeChunk(
    fileId: string,
    chunkIndex: number,
    chunkData: Uint8Array,
    proof: Uint8Array[],
  ): Promise<void>;

  /**
   * Get the current upload progress for a file.
   * @param fileId - The client UUID for this file
   * @returns Upload progress or null if not found
   */
  getUploadProgress(fileId: string): Promise<UploadProgress | null>;

  /**
   * Complete an upload and store the file by contentId.
   * @param fileId - The client UUID for this file
   * @param contentId - The merkle root hash (contentId)
   */
  completeUpload(fileId: string, contentId: Uint8Array): Promise<void>;

  /**
   * Get a file by its contentId (merkle root hash).
   * @param contentId - The contentId (merkle root hash) as base64 string
   * @returns File data or null if not found
   */
  getFile(contentId: string): Promise<FileData | null>;

  /**
   * Clean up expired upload sessions.
   * Uploads expire after a configurable timeout (default 24h).
   */
  cleanupExpiredUploads(): Promise<void>;
}

/**
 * In-memory implementation of FileStorage.
 */
export class InMemoryFileStorage implements FileStorage {
  // Active uploads by fileId
  #uploads = new Map<string, UploadProgress>();
  // Completed files by contentId (base64)
  #files = new Map<string, FileData>();
  // Upload expiration time (default 24 hours)
  #uploadExpirationMs: number;

  constructor(uploadExpirationMs: number = 24 * 60 * 60 * 1000) {
    this.#uploadExpirationMs = uploadExpirationMs;
  }

  async initiateUpload(
    fileId: string,
    metadata: FileMetadata,
  ): Promise<void> {
    const totalChunks = Math.ceil(metadata.size / (64 * 1024));
    this.#uploads.set(fileId, {
      fileId,
      metadata,
      chunks: new Map(),
      bytesUploaded: 0,
      totalChunks,
      lastChunkIndex: -1,
    });
  }

  async storeChunk(
    fileId: string,
    chunkIndex: number,
    chunkData: Uint8Array,
    proof: Uint8Array[],
  ): Promise<void> {
    const upload = this.#uploads.get(fileId);
    if (!upload) {
      throw new Error(`Upload not found for fileId: ${fileId}`);
    }

    // Verify merkle proof if we have a contentId (for resumable uploads)
    // For now, we'll verify when completing the upload

    upload.chunks.set(chunkIndex, chunkData);
    upload.bytesUploaded += chunkData.length;
    upload.lastChunkIndex = Math.max(upload.lastChunkIndex, chunkIndex);
  }

  async getUploadProgress(
    fileId: string,
  ): Promise<UploadProgress | null> {
    const upload = this.#uploads.get(fileId);
    if (!upload) {
      return null;
    }

    // Check if expired
    const age = Date.now() - upload.metadata.createdAt;
    if (age > this.#uploadExpirationMs) {
      this.#uploads.delete(fileId);
      return null;
    }

    return { ...upload };
  }

  async completeUpload(
    fileId: string,
    contentId: Uint8Array,
  ): Promise<void> {
    const upload = this.#uploads.get(fileId);
    if (!upload) {
      throw new Error(`Upload not found for fileId: ${fileId}`);
    }

    // Verify all chunks are present
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < upload.totalChunks; i++) {
      const chunk = upload.chunks.get(i);
      if (!chunk) {
        throw new Error(`Missing chunk ${i} for fileId: ${fileId}`);
      }
      chunks.push(chunk);
    }

    // Build merkle tree and verify root matches contentId
    const { buildMerkleTree } = await import("../lib/protocol/file-upload");
    const merkleTree = buildMerkleTree(chunks);

    // Compare contentId with root hash
    if (
      merkleTree.root.hash.length !== contentId.length ||
      !merkleTree.root.hash.every((byte, i) => byte === contentId[i])
    ) {
      throw new Error(
        `ContentId mismatch for fileId: ${fileId}. Expected root hash does not match computed root.`,
      );
    }

    // Store file by contentId
    const contentIdBase64 = toBase64(contentId);
    this.#files.set(contentIdBase64, {
      contentId,
      metadata: upload.metadata,
      chunks,
      merkleTree,
    });

    // Clean up upload session
    this.#uploads.delete(fileId);
  }

  async getFile(contentId: string): Promise<FileData | null> {
    return this.#files.get(contentId) ?? null;
  }

  async cleanupExpiredUploads(): Promise<void> {
    const now = Date.now();
    for (const [fileId, upload] of this.#uploads.entries()) {
      const age = now - upload.metadata.createdAt;
      if (age > this.#uploadExpirationMs) {
        this.#uploads.delete(fileId);
      }
    }
  }
}
