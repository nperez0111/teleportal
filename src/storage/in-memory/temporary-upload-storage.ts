import { toBase64 } from "lib0/buffer";
import type { MerkleTree } from "teleportal/merkle-tree";
import { buildMerkleTree, serializeMerkleTree } from "teleportal/merkle-tree";
import type {
  File,
  FileMetadata,
  FileUploadResult,
  TemporaryUploadStorage,
  UploadProgress,
} from "../types";

type UploadSession = {
  metadata: FileMetadata;
  chunks: Map<number, Uint8Array>;
  bytesUploaded: number;
  lastActivity: number;
  completing?: boolean;
};

/**
 * In-memory temporary upload storage.
 *
 * Stores upload sessions and chunks in memory. After completion, use the returned
 * getChunk function to move chunks to durable storage incrementally.
 */
export class InMemoryTemporaryUploadStorage implements TemporaryUploadStorage {
  readonly type = "temporary-upload-storage" as const;

  #sessions = new Map<string, UploadSession>();
  #uploadTimeoutMs: number;

  constructor(options?: { uploadTimeoutMs?: number }) {
    this.#uploadTimeoutMs = options?.uploadTimeoutMs ?? 2 * 60 * 60 * 1000; // 2 hours
  }

  async beginUpload(uploadId: string, metadata: FileMetadata): Promise<void> {
    const existing = this.#sessions.get(uploadId);
    if (existing) {
      existing.lastActivity = Date.now();
      return;
    }

    this.#sessions.set(uploadId, {
      metadata: {
        ...metadata,
        lastModified: metadata.lastModified || Date.now(),
      },
      chunks: new Map(),
      bytesUploaded: 0,
      lastActivity: Date.now(),
    });
  }

  async storeChunk(
    uploadId: string,
    chunkIndex: number,
    chunkData: Uint8Array,
    _proof: Uint8Array[],
  ): Promise<{ storedChunks: number }> {
    const session = this.#sessions.get(uploadId);
    if (!session) {
      throw new Error(`Upload session ${uploadId} not found`);
    }

    const existing = session.chunks.get(chunkIndex);
    if (existing) {
      session.bytesUploaded -= existing.length;
    }
    session.chunks.set(chunkIndex, chunkData);
    session.bytesUploaded += chunkData.length;
    session.lastActivity = Date.now();
    return { storedChunks: session.chunks.size };
  }

  async getUploadProgress(uploadId: string): Promise<UploadProgress | null> {
    const session = this.#sessions.get(uploadId);
    if (!session) {
      return null;
    }

    const chunks = new Map<number, boolean>();
    for (const idx of session.chunks.keys()) {
      chunks.set(idx, true);
    }

    return {
      metadata: session.metadata,
      chunks,
      merkleTree: null as MerkleTree | null,
      bytesUploaded: session.bytesUploaded,
      lastActivity: session.lastActivity,
    };
  }

  async completeUpload(
    uploadId: string,
    totalChunks: number,
    fileId?: File["id"],
  ): Promise<FileUploadResult> {
    const session = this.#sessions.get(uploadId);
    if (!session) {
      throw new Error(`Upload session ${uploadId} not found`);
    }
    if (session.completing) {
      throw new Error(`Upload ${uploadId} is already being completed`);
    }
    session.completing = true;

    for (let i = 0; i < totalChunks; i++) {
      if (!session.chunks.has(i)) {
        throw new Error(`Missing chunk ${i} for upload ${uploadId}`);
      }
    }

    const chunksInOrder: Uint8Array[] = [];
    for (let i = 0; i < totalChunks; i++) {
      chunksInOrder.push(session.chunks.get(i)!);
    }

    const merkleTree = await buildMerkleTree(chunksInOrder);
    const root = merkleTree.nodes.at(-1);
    if (!root?.hash) {
      throw new Error(`Failed to compute root hash for upload ${uploadId}`);
    }
    const rootHash = root.hash;

    const computedFileId = toBase64(rootHash);
    // If fileId is provided, validate it matches the computed one
    if (fileId !== undefined && computedFileId !== fileId) {
      throw new Error(
        `Merkle root mismatch for upload ${uploadId}. Expected ${fileId}, got ${computedFileId}`,
      );
    }

    const finalFileId = fileId ?? computedFileId;
    const progress = (await this.getUploadProgress(uploadId))!;

    // Track which chunks have been fetched via getChunk
    const fetchedChunks = new Set<number>();

    // Release chunksInOrder array to allow GC (we've computed the merkle tree)
    // Chunks remain in session.chunks and will be retrieved via getChunk

    return {
      progress,
      fileId: finalFileId,
      contentId: rootHash,
      totalChunks,
      serializedMerkleTree: serializeMerkleTree(merkleTree),
      getChunk: async (chunkIndex: number) => {
        // Check if chunk was already fetched (one-time use)
        if (fetchedChunks.has(chunkIndex)) {
          throw new Error(
            `Chunk ${chunkIndex} has already been fetched for upload ${uploadId}. Chunks can only be fetched once.`,
          );
        }

        const chunk = session.chunks.get(chunkIndex);
        if (!chunk) {
          throw new Error(`Chunk ${chunkIndex} not found for upload ${uploadId}`);
        }

        // Mark as fetched and remove from session
        fetchedChunks.add(chunkIndex);
        session.chunks.delete(chunkIndex);

        // If all chunks have been fetched, clean up the session
        if (session.chunks.size === 0) {
          this.#sessions.delete(uploadId);
        }

        return chunk;
      },
    };
  }

  async cleanupExpiredUploads(): Promise<void> {
    const now = Date.now();
    for (const [uploadId, session] of this.#sessions.entries()) {
      if (now - session.lastActivity > this.#uploadTimeoutMs) {
        this.#sessions.delete(uploadId);
      }
    }
  }
}
