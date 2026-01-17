import type { Storage } from "unstorage";
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
    this.#uploadTimeoutMs =
      options?.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
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

  #getFileKey(fileId: string): string {
    return `${this.#keyPrefix}:file:${fileId}`;
  }

  async beginUpload(uploadId: string, metadata: FileMetadata): Promise<void> {
    const sessionKey = this.#getUploadSessionKey(uploadId);
    const existing = await this.#storage.getItem(sessionKey);
    if (existing) {
      throw new Error(`Upload session ${uploadId} already exists`);
    }

    await this.#storage.setItem(sessionKey, {
      metadata: {
        ...metadata,
        lastModified: metadata.lastModified || Date.now(),
      },
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
    const sessionKey = this.#getUploadSessionKey(uploadId);
    const sessionData = await this.#storage.getItem<{
      metadata: FileMetadata;
      bytesUploaded: number;
      lastActivity: number;
    }>(sessionKey);

    if (!sessionData) {
      throw new Error(`Upload session ${uploadId} not found`);
    }

    await this.#storage.setItemRaw(
      this.#getChunkKey(uploadId, chunkIndex),
      chunkData,
    );

    // Recompute bytesUploaded from all stored chunks for correctness.
    const chunkKeys = await this.#storage.getKeys(
      this.#getChunkKeyPrefix(uploadId),
    );
    const chunks = await Promise.all(
      chunkKeys.map((k) => this.#storage.getItemRaw<Uint8Array>(k)),
    );
    const bytesUploaded = chunks
      .filter(Boolean)
      .reduce((sum, c) => sum + c!.length, 0);

    await this.#storage.setItem(sessionKey, {
      ...sessionData,
      lastActivity: Date.now(),
      bytesUploaded,
    });
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

    const chunkKeys = await this.#storage.getKeys(
      this.#getChunkKeyPrefix(uploadId),
    );
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
    fileId?: File["id"],
  ): Promise<FileUploadResult> {
    const progress = await this.getUploadProgress(uploadId);
    if (!progress) {
      throw new Error(`Upload session ${uploadId} not found`);
    }

    const expectedChunks =
      progress.metadata.size === 0
        ? 1
        : Math.ceil(progress.metadata.size / CHUNK_SIZE);

    for (let i = 0; i < expectedChunks; i++) {
      if (!progress.chunks.get(i)) {
        throw new Error(`Missing chunk ${i} for upload ${uploadId}`);
      }
    }

    const chunksInOrder: Uint8Array[] = [];
    for (let i = 0; i < expectedChunks; i++) {
      const stored = await this.#storage.getItemRaw<Uint8Array>(
        this.#getChunkKey(uploadId, i),
      );
      if (!stored) {
        throw new Error(`Chunk ${i} not found for upload ${uploadId}`);
      }
      chunksInOrder.push(stored);
    }

    const totalSize = chunksInOrder.reduce((sum, c) => sum + c.length, 0);
    if (totalSize !== progress.metadata.size) {
      throw new Error(
        `Size mismatch for upload ${uploadId}. Expected ${progress.metadata.size}, got ${totalSize}`,
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

    // Track which chunks have been fetched via getChunk
    const fetchedChunks = new Set<number>();

    // Release chunksInOrder array to allow GC (we've computed the merkle tree)
    // Chunks remain in storage and will be retrieved via getChunk

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

        const chunkKey = this.#getChunkKey(uploadId, chunkIndex);
        const stored = await this.#storage.getItemRaw<Uint8Array>(chunkKey);
        if (!stored) {
          throw new Error(
            `Chunk ${chunkIndex} not found for upload ${uploadId}`,
          );
        }

        // Mark as fetched and delete from temporary storage
        fetchedChunks.add(chunkIndex);
        await this.#storage.removeItem(chunkKey);

        // Check if all chunks have been fetched and clean up session
        const remainingChunkKeys = await this.#storage.getKeys(
          this.#getChunkKeyPrefix(uploadId),
        );
        if (remainingChunkKeys.length === 0) {
          // All chunks have been fetched, clean up the session
          await this.#storage.removeItem(this.#getUploadSessionKey(uploadId));
        }

        return stored;
      },
    };
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
        // Delete chunks
        const chunkKeys = await this.#storage.getKeys(
          this.#getChunkKeyPrefix(uploadId),
        );
        await Promise.all(chunkKeys.map((k) => this.#storage.removeItem(k)));
        // Delete session metadata
        await this.#storage.removeItem(this.#getUploadSessionKey(uploadId));
      }
    }
  }
}
