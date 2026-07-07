import { toBase64 } from "teleportal/utils";
import type { MerkleTree } from "teleportal/merkle-tree";
import { buildMerkleTree, serializeMerkleTree } from "teleportal/merkle-tree";

import type {
  File,
  FileMetadata,
  FileStorage,
  FileUploadResult,
  TemporaryUploadStorage,
  UploadProgress,
} from "teleportal/storage";

import { deleteKeys, type DurableObjectStorageLike, KeyedMutex, listAll } from "./types";

/**
 * Default upload timeout in milliseconds (24 hours)
 */
const DEFAULT_UPLOAD_TIMEOUT_MS = 24 * 60 * 60 * 1000;

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

type UploadSession = {
  metadata: FileMetadata;
  bytesUploaded: number;
  /** Indexes of stored chunks — kept in the session so counting and
   * enumeration never have to `list()` the 1 MiB chunk values. */
  chunkIndexes: number[];
  documentIds: string[];
  lastActivity: number;
};

/**
 * Temporary upload storage backed directly by Durable Object storage.
 *
 * Sessions and chunks live under separate key prefixes so listing sessions
 * (e.g. during cleanup) never loads chunk bytes — Durable Object `list()`
 * always returns values along with keys.
 *
 * Storage layout:
 * - `{prefix}:upload-session:{uploadId}`          -- session record
 * - `{prefix}:upload-chunk:{uploadId}:{index}`    -- chunk bytes (≤1 MiB each)
 */
export class DurableObjectTemporaryUploadStorage implements TemporaryUploadStorage {
  readonly type = "temporary-upload-storage" as const;

  readonly #storage: DurableObjectStorageLike;
  readonly #keyPrefix: string;
  readonly #uploadTimeoutMs: number;
  readonly #mutex = new KeyedMutex();

  constructor(
    storage: DurableObjectStorageLike,
    options?: {
      uploadTimeoutMs?: number;
      keyPrefix?: string;
    },
  ) {
    this.#storage = storage;
    this.#uploadTimeoutMs = options?.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
    this.#keyPrefix = options?.keyPrefix ?? "file";
  }

  #getSessionKey(uploadId: string): string {
    return `${this.#keyPrefix}:upload-session:${uploadId}`;
  }

  #getSessionKeyPrefix(): string {
    return `${this.#keyPrefix}:upload-session:`;
  }

  #getChunkKey(uploadId: string, chunkIndex: number): string {
    return `${this.#keyPrefix}:upload-chunk:${uploadId}:${chunkIndex}`;
  }

  async beginUpload(uploadId: string, metadata: FileMetadata): Promise<void> {
    await this.#mutex.run(uploadId, async () => {
      const sessionKey = this.#getSessionKey(uploadId);
      const existing = await this.#storage.get<UploadSession>(sessionKey);
      if (existing) {
        // Content-addressed sessions may be shared across documents; the
        // content must match, only the referencing document may differ.
        if (
          existing.metadata.size !== metadata.size ||
          existing.metadata.encrypted !== metadata.encrypted
        ) {
          throw new Error(`Upload session ${uploadId} already exists with conflicting metadata`);
        }
        const documentIds = new Set(existing.documentIds);
        documentIds.add(metadata.documentId);
        await this.#storage.put<UploadSession>(sessionKey, {
          ...existing,
          documentIds: [...documentIds],
          lastActivity: Date.now(),
        });
        return;
      }

      await this.#storage.put<UploadSession>(sessionKey, {
        metadata: {
          ...metadata,
          lastModified: metadata.lastModified || Date.now(),
        },
        bytesUploaded: 0,
        chunkIndexes: [],
        documentIds: [metadata.documentId],
        lastActivity: Date.now(),
      });
    });
  }

  async storeChunk(
    uploadId: string,
    chunkIndex: number,
    chunkData: Uint8Array,
    _proof: Uint8Array[],
  ): Promise<{ storedChunks: number }> {
    return this.#mutex.run(uploadId, async () => {
      const sessionKey = this.#getSessionKey(uploadId);
      const session = await this.#storage.get<UploadSession>(sessionKey);
      if (!session) {
        throw new Error(`Upload session ${uploadId} not found`);
      }

      const chunkKey = this.#getChunkKey(uploadId, chunkIndex);
      const existing = await this.#storage.get<Uint8Array>(chunkKey);
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
        return { storedChunks: session.chunkIndexes.length };
      }

      await this.#storage.put(chunkKey, chunkData);
      const chunkIndexes = [...session.chunkIndexes, chunkIndex];
      await this.#storage.put<UploadSession>(sessionKey, {
        ...session,
        lastActivity: Date.now(),
        bytesUploaded: session.bytesUploaded + chunkData.length,
        chunkIndexes,
      });

      return { storedChunks: chunkIndexes.length };
    });
  }

  async getUploadProgress(uploadId: string): Promise<UploadProgress | null> {
    const session = await this.#storage.get<UploadSession>(this.#getSessionKey(uploadId));
    if (!session) {
      return null;
    }

    return {
      metadata: session.metadata,
      chunks: new Map(session.chunkIndexes.map((index) => [index, true])),
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
    const progress = await this.getUploadProgress(uploadId);
    if (!progress) {
      throw new Error(`Upload session ${uploadId} not found`);
    }

    const session = await this.#storage.get<UploadSession>(this.#getSessionKey(uploadId));
    const documentIds = session?.documentIds ?? [progress.metadata.documentId];

    for (let i = 0; i < totalChunks; i++) {
      if (!progress.chunks.get(i)) {
        throw new Error(`Missing chunk ${i} for upload ${uploadId}`);
      }
    }

    const chunksInOrder: Uint8Array[] = [];
    for (let i = 0; i < totalChunks; i++) {
      const stored = await this.#storage.get<Uint8Array>(this.#getChunkKey(uploadId, i));
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

    // Chunks are NOT deleted here; they remain until deleteUpload so a failed
    // durable store leaves the session intact and retriable.
    return {
      progress,
      fileId: fileId ?? computedFileId,
      contentId: rootHash,
      totalChunks,
      documentIds,
      serializedMerkleTree: serializeMerkleTree(merkleTree),
      getChunk: async (chunkIndex: number) => {
        const stored = await this.#storage.get<Uint8Array>(this.#getChunkKey(uploadId, chunkIndex));
        if (!stored) {
          throw new Error(`Chunk ${chunkIndex} not found for upload ${uploadId}`);
        }
        return stored;
      },
    };
  }

  async deleteUpload(uploadId: string): Promise<void> {
    await this.#mutex.run(uploadId, async () => {
      const session = await this.#storage.get<UploadSession>(this.#getSessionKey(uploadId));
      const chunkKeys = (session?.chunkIndexes ?? []).map((index) =>
        this.#getChunkKey(uploadId, index),
      );
      await deleteKeys(this.#storage, [...chunkKeys, this.#getSessionKey(uploadId)]);
    });
  }

  async cleanupExpiredUploads(): Promise<void> {
    const now = Date.now();
    const prefix = this.#getSessionKeyPrefix();
    const sessions = await listAll<UploadSession>(this.#storage, prefix);
    for (const [key, session] of sessions) {
      if (now - session.lastActivity > this.#uploadTimeoutMs) {
        await this.deleteUpload(key.slice(prefix.length));
      }
    }
  }
}

type FileManifest = {
  metadata: FileMetadata;
  contentId: Uint8Array;
  totalChunks: number;
  serializedMerkleTree?: Uint8Array;
};

/**
 * File storage backed directly by Durable Object storage.
 *
 * Storage layout:
 * - `{prefix}:file-manifest:{fileId}`         -- metadata, contentId, merkle tree
 * - `{prefix}:file-chunk:{fileId}:{index}`    -- chunk bytes (≤1 MiB each)
 */
export class DurableObjectFileStorage implements FileStorage {
  readonly type = "file-storage" as const;

  temporaryUploadStorage?: TemporaryUploadStorage;
  readonly #storage: DurableObjectStorageLike;
  readonly #keyPrefix: string;

  constructor(
    storage: DurableObjectStorageLike,
    options?: {
      keyPrefix?: string;
      temporaryUploadStorage?: TemporaryUploadStorage;
    },
  ) {
    this.#storage = storage;
    this.#keyPrefix = options?.keyPrefix ?? "file";
    this.temporaryUploadStorage = options?.temporaryUploadStorage;
  }

  #getManifestKey(fileId: string): string {
    return `${this.#keyPrefix}:file-manifest:${fileId}`;
  }

  #getChunkKey(fileId: string, chunkIndex: number): string {
    return `${this.#keyPrefix}:file-chunk:${fileId}:${chunkIndex}`;
  }

  async getFile(fileId: File["id"]): Promise<File | null> {
    const manifest = await this.#storage.get<FileManifest>(this.#getManifestKey(fileId));
    if (!manifest) return null;

    const chunks = await Promise.all(
      Array.from({ length: manifest.totalChunks }, (_, i) =>
        this.#storage.get<Uint8Array>(this.#getChunkKey(fileId, i)),
      ),
    );
    const validChunks = chunks.filter((c): c is Uint8Array => c !== undefined);

    return {
      id: fileId,
      metadata: manifest.metadata,
      chunks: validChunks,
      contentId: manifest.contentId,
      serializedMerkleTree: manifest.serializedMerkleTree,
    };
  }

  async deleteFile(fileId: File["id"]): Promise<void> {
    const manifest = await this.#storage.get<FileManifest>(this.#getManifestKey(fileId));
    if (!manifest) return;

    const chunkKeys = Array.from({ length: manifest.totalChunks }, (_, i) =>
      this.#getChunkKey(fileId, i),
    );
    await deleteKeys(this.#storage, [...chunkKeys, this.#getManifestKey(fileId)]);
  }

  async storeFileFromUpload(uploadResult: FileUploadResult): Promise<void> {
    await this.#storage.put<FileManifest>(this.#getManifestKey(uploadResult.fileId), {
      metadata: uploadResult.progress.metadata,
      contentId: uploadResult.contentId,
      totalChunks: uploadResult.totalChunks,
      serializedMerkleTree: uploadResult.serializedMerkleTree,
    });

    // Fetch and store chunks incrementally — one chunk in memory at a time
    for (let i = 0; i < uploadResult.totalChunks; i++) {
      const chunk = await uploadResult.getChunk(i);
      await this.#storage.put(this.#getChunkKey(uploadResult.fileId, i), chunk);
    }
  }
}
