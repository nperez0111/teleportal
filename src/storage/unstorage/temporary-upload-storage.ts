import { toBase64 } from "teleportal/utils";
import type { MerkleTree } from "teleportal/merkle-tree";
import { buildMerkleTree, serializeMerkleTree } from "teleportal/merkle-tree";
import type { Storage } from "unstorage";
import type {
  File,
  FileMetadata,
  FileUploadResult,
  TemporaryUploadStorage,
  UploadProgress,
} from "../types";
import { bytesEqual } from "../utils";

/**
 * Default upload timeout in milliseconds (24 hours)
 */
const DEFAULT_UPLOAD_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * Unstorage-based temporary upload storage.
 *
 * Stores upload session metadata and chunks in unstorage. After completion,
 * use the returned getChunk function to move chunks to durable storage incrementally.
 */
export class UnstorageTemporaryUploadStorage implements TemporaryUploadStorage {
  readonly type = "temporary-upload-storage" as const;

  #storage: Storage;
  #keyPrefix: string;
  #uploadTimeoutMs: number;

  constructor(
    storage: Storage,
    options?: {
      uploadTimeoutMs?: number;
      keyPrefix?: string;
    },
  ) {
    this.#storage = storage;
    this.#uploadTimeoutMs = options?.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
    this.#keyPrefix = options?.keyPrefix ?? "file";
  }

  #getUploadSessionKey(uploadId: string): string {
    return `${this.#keyPrefix}:upload:${uploadId}`;
  }

  #getChunkKey(uploadId: string, chunkIndex: number): string {
    return `${this.#keyPrefix}:upload:${uploadId}:chunk:${chunkIndex}`;
  }

  #getChunkKeyPrefix(uploadId: string): string {
    return `${this.#keyPrefix}:upload:${uploadId}:chunk:`;
  }

  #getUploadKeyPrefix(): string {
    return `${this.#keyPrefix}:upload:`;
  }

  async beginUpload(uploadId: string, metadata: FileMetadata): Promise<void> {
    const sessionKey = this.#getUploadSessionKey(uploadId);
    const existing = await this.#storage.getItem<{
      metadata: FileMetadata;
      documentIds?: string[];
    }>(sessionKey);
    if (existing) {
      // Content-addressed sessions may be shared across documents; the content
      // must match, only the referencing document may differ.
      if (
        existing.metadata.size !== metadata.size ||
        existing.metadata.encrypted !== metadata.encrypted
      ) {
        throw new Error(`Upload session ${uploadId} already exists with conflicting metadata`);
      }
      const documentIds = new Set(existing.documentIds ?? [existing.metadata.documentId]);
      documentIds.add(metadata.documentId);
      await this.#storage.setItem(sessionKey, {
        ...(existing as Record<string, unknown>),
        documentIds: [...documentIds],
        lastActivity: Date.now(),
      });
      return;
    }

    await this.#storage.setItem(sessionKey, {
      metadata: {
        ...metadata,
        lastModified: metadata.lastModified || Date.now(),
      },
      bytesUploaded: 0,
      chunkCount: 0,
      documentIds: [metadata.documentId],
      lastActivity: Date.now(),
    });
  }

  async storeChunk(
    uploadId: string,
    chunkIndex: number,
    chunkData: Uint8Array,
    _proof: Uint8Array[],
  ): Promise<{ storedChunks: number }> {
    const sessionKey = this.#getUploadSessionKey(uploadId);
    const sessionData = await this.#storage.getItem<{
      metadata: FileMetadata;
      bytesUploaded: number;
      chunkCount: number;
      lastActivity: number;
    }>(sessionKey);

    if (!sessionData) {
      throw new Error(`Upload session ${uploadId} not found`);
    }

    const chunkKey = this.#getChunkKey(uploadId, chunkIndex);
    const existing = await this.#storage.getItemRaw<Uint8Array>(chunkKey);

    if (existing) {
      // Refuse to overwrite an already-stored chunk with different bytes — a
      // content-addressed session id is guessable, so this guards against a
      // third party poisoning an in-flight upload. Identical bytes are a
      // harmless retransmit; leave storage untouched.
      if (!bytesEqual(existing, chunkData)) {
        throw new Error(
          `Chunk ${chunkIndex} for upload ${uploadId} conflicts with already-stored data`,
        );
      }
      const chunkKeys = await this.#storage.getKeys(this.#getChunkKeyPrefix(uploadId));
      return { storedChunks: chunkKeys.length };
    }

    await this.#storage.setItemRaw(chunkKey, chunkData);

    // Derive the count from actual persisted keys to avoid stale read-modify-write races
    const chunkPrefix = this.#getChunkKeyPrefix(uploadId);
    const chunkKeys = await this.#storage.getKeys(chunkPrefix);
    const storedChunks = chunkKeys.length;

    await this.#storage.setItem(sessionKey, {
      ...sessionData,
      lastActivity: Date.now(),
      bytesUploaded: sessionData.bytesUploaded + chunkData.length,
      chunkCount: storedChunks,
    });

    return { storedChunks };
  }

  async getUploadProgress(uploadId: string): Promise<UploadProgress | null> {
    const sessionKey = this.#getUploadSessionKey(uploadId);
    const sessionData = await this.#storage.getItem<{
      metadata: FileMetadata;
      bytesUploaded: number;
      lastActivity: number;
    }>(sessionKey);

    if (!sessionData) {
      return null;
    }

    const chunkKeys = await this.#storage.getKeys(this.#getChunkKeyPrefix(uploadId));
    const chunks = new Map<number, boolean>();
    for (const k of chunkKeys) {
      const chunkIndex = Number.parseInt(k.split(":chunk:")[1] ?? "-1", 10);
      if (chunkIndex >= 0) {
        chunks.set(chunkIndex, true);
      }
    }

    return {
      metadata: sessionData.metadata,
      chunks,
      merkleTree: null as MerkleTree | null,
      bytesUploaded: sessionData.bytesUploaded,
      lastActivity: sessionData.lastActivity,
    };
  }

  async completeUpload(
    uploadId: string,
    totalChunks: number,
    fileId?: File["id"],
  ): Promise<FileUploadResult> {
    const progress = await this.getUploadProgress(uploadId);
    if (!progress) {
      throw new Error(`Upload session ${uploadId} not found`);
    }

    const sessionData = await this.#storage.getItem<{
      metadata: FileMetadata;
      documentIds?: string[];
    }>(this.#getUploadSessionKey(uploadId));
    const documentIds = sessionData?.documentIds ?? [progress.metadata.documentId];

    for (let i = 0; i < totalChunks; i++) {
      if (!progress.chunks.get(i)) {
        throw new Error(`Missing chunk ${i} for upload ${uploadId}`);
      }
    }

    const chunksInOrder: Uint8Array[] = [];
    for (let i = 0; i < totalChunks; i++) {
      const stored = await this.#storage.getItemRaw<Uint8Array>(this.#getChunkKey(uploadId, i));
      if (!stored) {
        throw new Error(`Chunk ${i} not found for upload ${uploadId}`);
      }
      chunksInOrder.push(stored);
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

    // Chunks are NOT deleted here; they remain until deleteUpload so a failed
    // durable store leaves the session intact and retriable.
    return {
      progress,
      fileId: finalFileId,
      contentId: rootHash,
      totalChunks,
      documentIds,
      serializedMerkleTree: serializeMerkleTree(merkleTree),
      getChunk: async (chunkIndex: number) => {
        const chunkKey = this.#getChunkKey(uploadId, chunkIndex);
        const stored = await this.#storage.getItemRaw<Uint8Array>(chunkKey);
        if (!stored) {
          throw new Error(`Chunk ${chunkIndex} not found for upload ${uploadId}`);
        }
        return stored;
      },
    };
  }

  async deleteUpload(uploadId: string): Promise<void> {
    const chunkKeys = await this.#storage.getKeys(this.#getChunkKeyPrefix(uploadId));
    await Promise.all(chunkKeys.map((k) => this.#storage.removeItem(k)));
    await this.#storage.removeItem(this.#getUploadSessionKey(uploadId));
  }

  async cleanupExpiredUploads(): Promise<void> {
    const now = Date.now();
    const uploadKeyPrefix = this.#getUploadKeyPrefix();
    const uploadKeys = await this.#storage.getKeys(uploadKeyPrefix);

    for (const key of uploadKeys) {
      // Only process session metadata keys (not chunk keys)
      if (key.includes(":chunk:")) {
        continue;
      }

      const uploadId = key.split(uploadKeyPrefix)[1];
      if (!uploadId) continue;

      const progress = await this.getUploadProgress(uploadId);
      if (!progress) continue;

      if (now - progress.lastActivity > this.#uploadTimeoutMs) {
        await this.deleteUpload(uploadId);
      }
    }
  }
}
