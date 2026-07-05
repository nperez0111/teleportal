import { toBase64 } from "teleportal/utils";
import type { MerkleTree } from "teleportal/merkle-tree";
import { buildMerkleTree, serializeMerkleTree } from "teleportal/merkle-tree";
import type {
  File,
  FileMetadata,
  FileUploadResult,
  TemporaryUploadStorage,
  UploadProgress,
} from "../types";
import { bytesEqual } from "../utils";

type UploadSession = {
  metadata: FileMetadata;
  chunks: Map<number, Uint8Array>;
  bytesUploaded: number;
  lastActivity: number;
  /** All document ids that have requested this (content-addressed) session. */
  documentIds: Set<string>;
  /**
   * In-flight/settled completion, cached so concurrent completions of the same
   * (content-addressed) session share one result instead of the second caller
   * throwing.
   */
  completion?: Promise<FileUploadResult>;
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
      // A content-addressed session may be shared across documents/clients. The
      // content (size, encryption) must match; only the referencing document may
      // differ. A mismatch means someone is trying to reuse the id for different
      // content — reject rather than corrupt the shared session.
      if (
        existing.metadata.size !== metadata.size ||
        existing.metadata.encrypted !== metadata.encrypted
      ) {
        throw new Error(`Upload session ${uploadId} already exists with conflicting metadata`);
      }
      existing.documentIds.add(metadata.documentId);
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
      documentIds: new Set([metadata.documentId]),
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
      // Content-addressed session ids are guessable, so refuse to overwrite an
      // already-stored chunk with different bytes — that would let a third party
      // poison an in-flight upload (its merkle root would then fail to match).
      // Identical bytes are a harmless retransmit.
      if (!bytesEqual(existing, chunkData)) {
        throw new Error(
          `Chunk ${chunkIndex} for upload ${uploadId} conflicts with already-stored data`,
        );
      }
      return { storedChunks: session.chunks.size };
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

    // Idempotent: concurrent completions of the same content-addressed session
    // share one result rather than the second caller throwing. The completion
    // never mutates the session (chunks stay until deleteUpload), so replaying
    // a settled promise is safe.
    if (!session.completion) {
      session.completion = this.#completeUpload(uploadId, session, totalChunks, fileId).catch(
        (err) => {
          // Allow a later retry after a genuine failure (e.g. root mismatch).
          session.completion = undefined;
          throw err;
        },
      );
    }
    return session.completion;
  }

  async #completeUpload(
    uploadId: string,
    session: UploadSession,
    totalChunks: number,
    fileId?: File["id"],
  ): Promise<FileUploadResult> {
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
    if (fileId !== undefined && computedFileId !== fileId) {
      throw new Error(
        `Merkle root mismatch for upload ${uploadId}. Expected ${fileId}, got ${computedFileId}`,
      );
    }

    const finalFileId = fileId ?? computedFileId;
    const progress = (await this.getUploadProgress(uploadId))!;

    return {
      progress,
      fileId: finalFileId,
      contentId: rootHash,
      totalChunks,
      documentIds: [...session.documentIds],
      serializedMerkleTree: serializeMerkleTree(merkleTree),
      getChunk: async (chunkIndex: number) => {
        const chunk = session.chunks.get(chunkIndex);
        if (!chunk) {
          throw new Error(`Chunk ${chunkIndex} not found for upload ${uploadId}`);
        }
        return chunk;
      },
    };
  }

  async deleteUpload(uploadId: string): Promise<void> {
    this.#sessions.delete(uploadId);
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
