import type { Storage } from "unstorage";
import type { MerkleTree } from "teleportal/merkle-tree";
import { buildMerkleTree, CHUNK_SIZE } from "../../lib/merkle-tree/merkle-tree";
import { toBase64 } from "lib0/buffer";
import type {
  File,
  FileMetadata,
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
 * Stores upload session metadata and chunks in unstorage and, on completion,
 * persists a full file record using the same key scheme as `UnstorageFileStorage`
 * (i.e. `${keyPrefix}:file:${fileId}` + per-chunk keys).
 */
export class UnstorageTemporaryUploadStorage implements TemporaryUploadStorage {
  readonly type = "temporary-upload-storage" as const;

  #storage: Storage;
  #keyPrefix: string;
  #uploadTimeoutMs: number;
  #onComplete?: (file: File) => Promise<void> | void;

  constructor(
    storage: Storage,
    options?: {
      uploadTimeoutMs?: number;
      keyPrefix?: string;
      onComplete?: (file: File) => Promise<void> | void;
    },
  ) {
    this.#storage = storage;
    this.#uploadTimeoutMs =
      options?.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
    this.#keyPrefix = options?.keyPrefix ?? "file";
    this.#onComplete = options?.onComplete;
  }

  #getUploadSessionKey(uploadId: string): string {
    return `${this.#keyPrefix}:upload:${uploadId}`;
  }

  #getChunkKey(uploadId: string, chunkIndex: number): string {
    return `${this.#keyPrefix}:upload:${uploadId}:chunk:${chunkIndex}`;
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
      `${this.#keyPrefix}:upload:${uploadId}:chunk:`,
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
      `${this.#keyPrefix}:upload:${uploadId}:chunk:`,
    );
    const chunks = new Map<number, boolean>();
    for (const k of chunkKeys) {
      const chunkIndex = parseInt(k.split(":chunk:")[1] ?? "-1", 10);
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
  ): Promise<{
    progress: UploadProgress;
    fileId: File["id"];
    getChunk: (chunkIndex: number) => Promise<Uint8Array>;
  }> {
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
    const rootHash = merkleTree.nodes[merkleTree.nodes.length - 1].hash!;
    const computedFileId = toBase64(rootHash);
    // If fileId is provided, validate it matches the computed one
    if (fileId !== undefined && computedFileId !== fileId) {
      throw new Error(
        `Merkle root mismatch for upload ${uploadId}. Expected ${fileId}, got ${computedFileId}`,
      );
    }

    const finalFileId = fileId ?? computedFileId;
    const file: File = {
      id: finalFileId,
      metadata: progress.metadata,
      chunks: chunksInOrder,
      contentId: rootHash,
    };

    // Persist the file record into the same backend (cold storage key scheme).
    const fileKey = this.#getFileKey(finalFileId);
    await this.#storage.setItem(fileKey, {
      metadata: file.metadata,
      contentId: Array.from(file.contentId),
      chunkKeys: file.chunks.map((_, index) => `${fileKey}:chunk:${index}`),
    });
    await Promise.all(
      file.chunks.map((chunk, index) =>
        this.#storage.setItemRaw(`${fileKey}:chunk:${index}`, chunk),
      ),
    );

    await this.#onComplete?.(file);

    return {
      progress,
      fileId: finalFileId,
      getChunk: async (chunkIndex: number) => {
        const stored = await this.#storage.getItemRaw<Uint8Array>(
          this.#getChunkKey(uploadId, chunkIndex),
        );
        if (!stored) {
          throw new Error(
            `Chunk ${chunkIndex} not found for upload ${uploadId}`,
          );
        }
        return stored;
      },
    };
  }

  async cleanupExpiredUploads(): Promise<void> {
    const now = Date.now();
    const uploadKeys = await this.#storage.getKeys(
      `${this.#keyPrefix}:upload:`,
    );

    for (const key of uploadKeys) {
      // Only process session metadata keys (not chunk keys)
      if (key.includes(":chunk:")) {
        continue;
      }

      const uploadId = key.split(`${this.#keyPrefix}:upload:`)[1];
      if (!uploadId) continue;

      const progress = await this.getUploadProgress(uploadId);
      if (!progress) continue;

      if (now - progress.lastActivity > this.#uploadTimeoutMs) {
        // Delete chunks
        const chunkKeys = await this.#storage.getKeys(
          `${this.#keyPrefix}:upload:${uploadId}:chunk:`,
        );
        await Promise.all(chunkKeys.map((k) => this.#storage.removeItem(k)));
        // Delete session metadata
        await this.#storage.removeItem(this.#getUploadSessionKey(uploadId));
      }
    }
  }
}
