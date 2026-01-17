import type { MerkleTree } from "teleportal/merkle-tree";
import { buildMerkleTree, CHUNK_SIZE } from "../../lib/merkle-tree/merkle-tree";
import { toBase64 } from "lib0/buffer";
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
    if (this.#sessions.has(uploadId)) {
      throw new Error(`Upload session ${uploadId} already exists`);
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
  ): Promise<void> {
    const session = this.#sessions.get(uploadId);
    if (!session) {
      throw new Error(`Upload session ${uploadId} not found`);
    }

    session.chunks.set(chunkIndex, chunkData);
    session.lastActivity = Date.now();
    session.bytesUploaded = [...session.chunks.values()].reduce(
      (sum, chunk) => sum + chunk.length,
      0,
    );
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
    fileId?: File["id"],
  ): Promise<FileUploadResult> {
    const session = this.#sessions.get(uploadId);
    if (!session) {
      throw new Error(`Upload session ${uploadId} not found`);
    }

    const expectedChunks =
      session.metadata.size === 0
        ? 1
        : Math.ceil(session.metadata.size / CHUNK_SIZE);

    for (let i = 0; i < expectedChunks; i++) {
      if (!session.chunks.has(i)) {
        throw new Error(`Missing chunk ${i} for upload ${uploadId}`);
      }
    }

    const chunksInOrder: Uint8Array[] = [];
    for (let i = 0; i < expectedChunks; i++) {
      chunksInOrder.push(session.chunks.get(i)!);
    }

    const totalSize = chunksInOrder.reduce((sum, c) => sum + c.length, 0);
    if (totalSize !== session.metadata.size) {
      throw new Error(
        `Size mismatch for upload ${uploadId}. Expected ${session.metadata.size}, got ${totalSize}`,
      );
    }

    const merkleTree = buildMerkleTree(chunksInOrder);
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
      getChunk: async (chunkIndex: number) => {
        // Check if chunk was already fetched (one-time use)
        if (fetchedChunks.has(chunkIndex)) {
          throw new Error(
            `Chunk ${chunkIndex} has already been fetched for upload ${uploadId}. Chunks can only be fetched once.`,
          );
        }

        const chunk = session.chunks.get(chunkIndex);
        if (!chunk) {
          throw new Error(
            `Chunk ${chunkIndex} not found for upload ${uploadId}`,
          );
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
