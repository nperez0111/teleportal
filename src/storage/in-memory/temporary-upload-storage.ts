import type { MerkleTree } from "teleportal/merkle-tree";
import { buildMerkleTree, CHUNK_SIZE } from "../../lib/merkle-tree/merkle-tree";
import { toBase64 } from "lib0/buffer";
import type {
  File,
  FileMetadata,
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
 * Stores upload sessions and chunks in memory and can optionally persist a completed
 * file via a callback.
 */
export class InMemoryTemporaryUploadStorage implements TemporaryUploadStorage {
  readonly type = "temporary-upload-storage" as const;

  #sessions = new Map<string, UploadSession>();
  #uploadTimeoutMs: number;
  #onComplete?: (file: File) => Promise<void> | void;

  constructor(options?: {
    uploadTimeoutMs?: number;
    onComplete?: (file: File) => Promise<void> | void;
  }) {
    this.#uploadTimeoutMs = options?.uploadTimeoutMs ?? 2 * 60 * 60 * 1000; // 2 hours
    this.#onComplete = options?.onComplete;
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
    session.bytesUploaded = Array.from(session.chunks.values()).reduce(
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
    fileId: File["id"],
  ): Promise<{
    progress: UploadProgress;
    getChunk: (chunkIndex: number) => Promise<Uint8Array>;
  }> {
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
    const rootHash = merkleTree.nodes[merkleTree.nodes.length - 1].hash!;

    const computedFileId = toBase64(rootHash);
    if (computedFileId !== fileId) {
      throw new Error(
        `Merkle root mismatch for upload ${uploadId}. Expected ${fileId}, got ${computedFileId}`,
      );
    }

    const progress = (await this.getUploadProgress(uploadId))!;

    const file: File = {
      id: fileId,
      metadata: session.metadata,
      chunks: chunksInOrder,
      contentId: rootHash,
    };

    await this.#onComplete?.(file);

    return {
      progress,
      getChunk: async (chunkIndex: number) => {
        const chunk = session.chunks.get(chunkIndex);
        if (!chunk) {
          throw new Error(`Chunk ${chunkIndex} not found for upload ${uploadId}`);
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

