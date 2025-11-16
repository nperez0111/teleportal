import {
  buildMerkleTree,
  type MerkleTree,
  verifyMerkleProof,
} from "../../lib/protocol/file-upload";
import type {
  FileData,
  FileMetadata,
  FileStorage,
  UploadProgress,
} from "../file-storage";

/**
 * Default upload timeout in milliseconds (24 hours)
 */
const DEFAULT_UPLOAD_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * In-memory implementation of FileStorage.
 * Stores files and upload sessions in memory.
 */
export class InMemoryFileStorage extends FileStorage {
  /**
   * Active upload sessions by fileId
   */
  #uploads = new Map<string, UploadProgress>();

  /**
   * Completed files by contentId (base64 encoded)
   */
  #files = new Map<string, FileData>();

  /**
   * Upload timeout in milliseconds
   */
  #uploadTimeoutMs: number;

  constructor(uploadTimeoutMs: number = DEFAULT_UPLOAD_TIMEOUT_MS) {
    super();
    this.#uploadTimeoutMs = uploadTimeoutMs;
  }

  async initiateUpload(fileId: string, metadata: FileMetadata): Promise<void> {
    if (this.#uploads.has(fileId)) {
      throw new Error(`Upload session ${fileId} already exists`);
    }

    this.#uploads.set(fileId, {
      metadata: {
        ...metadata,
        createdAt: Date.now(),
      },
      chunks: new Map(),
      merkleTree: null,
      bytesUploaded: 0,
      lastActivity: Date.now(),
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
      throw new Error(`Upload session ${fileId} not found`);
    }

    // Verify merkle proof if we have a merkle tree
    // For incremental verification, we'll verify against the expected root once complete
    // For now, we'll store the chunk and verify later

    // Store the chunk
    upload.chunks.set(chunkIndex, chunkData);
    upload.bytesUploaded += chunkData.length;
    upload.lastActivity = Date.now();

    // Rebuild merkle tree incrementally if we have all chunks up to this point
    // For simplicity, we'll rebuild the tree when completing the upload
  }

  async getUploadProgress(fileId: string): Promise<UploadProgress | null> {
    return this.#uploads.get(fileId) ?? null;
  }

  async completeUpload(fileId: string, contentId: Uint8Array): Promise<void> {
    const upload = this.#uploads.get(fileId);
    if (!upload) {
      throw new Error(`Upload session ${fileId} not found`);
    }

    // Calculate total chunks expected
    const totalChunks = Math.ceil(upload.metadata.size / (64 * 1024));

    // Verify we have all chunks
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < totalChunks; i++) {
      const chunk = upload.chunks.get(i);
      if (!chunk) {
        throw new Error(`Missing chunk ${i} for file ${fileId}`);
      }
      chunks.push(chunk);
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
        `Merkle root hash mismatch for file ${fileId}. Expected ${Array.from(contentId)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("")}, got ${Array.from(rootHash)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("")}`,
      );
    }

    // Verify all chunks with their proofs
    // Note: In a real implementation, proofs would be verified as chunks arrive
    // For now, we verify the tree structure is correct

    // Store file by contentId
    const contentIdKey = this.#contentIdToKey(contentId);
    this.#files.set(contentIdKey, {
      metadata: upload.metadata,
      chunks,
      contentId,
    });

    // Remove upload session
    this.#uploads.delete(fileId);
  }

  async getFile(contentId: Uint8Array): Promise<FileData | null> {
    const contentIdKey = this.#contentIdToKey(contentId);
    return this.#files.get(contentIdKey) ?? null;
  }

  async cleanupExpiredUploads(): Promise<void> {
    const now = Date.now();
    const expiredFileIds: string[] = [];

    for (const [fileId, upload] of this.#uploads.entries()) {
      if (now - upload.lastActivity > this.#uploadTimeoutMs) {
        expiredFileIds.push(fileId);
      }
    }

    for (const fileId of expiredFileIds) {
      this.#uploads.delete(fileId);
    }
  }

  /**
   * Convert contentId (Uint8Array) to a string key for Map storage
   */
  #contentIdToKey(contentId: Uint8Array): string {
    // Use base64-like encoding for the key
    return Array.from(contentId)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
}
