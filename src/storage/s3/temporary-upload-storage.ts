import { fromBase64, toBase64 } from "teleportal/utils";
import type { MerkleTree } from "teleportal/merkle-tree";
import {
  buildMerkleTreeFromLeafHashes,
  computeLeafHash,
  serializeMerkleTree,
} from "teleportal/merkle-tree";

import type {
  File,
  FileMetadata,
  FileUploadResult,
  TemporaryUploadStorage,
  UploadProgress,
} from "../types";
import { S3Http, mapLimit, type S3Config, type S3ObjectInfo } from "./client";

/** Default upload timeout in milliseconds (24 hours). */
const DEFAULT_UPLOAD_TIMEOUT_MS = 24 * 60 * 60 * 1000;

const DEFAULT_PREFIX = "teleportal/";
const LEAF_HASH_META = "leaf-hash";

/**
 * Capability handle attached to {@link FileUploadResult}s produced by
 * {@link S3TemporaryUploadStorage}, letting {@link S3FileStorage} promote
 * chunks with server-side CopyObject instead of GET+PUT through the app.
 */
export const S3_UPLOAD_INTERNAL = Symbol.for("teleportal.s3.upload-internal");

export interface S3UploadInternal {
  client: S3Http;
  chunkKey: (chunkIndex: number) => string;
  totalChunks: number;
}

type SessionJson = {
  version: 1;
  uploadId: string;
  metadata: FileMetadata;
  documentIds: string[];
  createdAt: number;
};

/**
 * Object keys must not contain raw base64 (`/` opens path levels, `+`/`=` are
 * URL hazards); translate to base64url. Bijective for base64 inputs, so
 * distinct ids stay distinct. The original id always lives in the JSON bodies.
 */
export function safeId(id: string): string {
  return id.replace(/\//g, "_").replace(/\+/g, "-").replace(/=/g, "");
}

/**
 * Temporary upload storage on S3/R2/MinIO.
 *
 * Layout (all under `{prefix}uploads/{safeId(uploadId)}/`):
 * - `session.json` — written by beginUpload only, never per chunk
 * - `chunks/{i}` — chunk bytes, carrying their domain-separated merkle leaf
 *   hash as the `x-amz-meta-leaf-hash` header
 *
 * Mutable progress (stored chunk count, bytes, last activity) derives from
 * ListObjectsV2 instead of a session counter, eliminating read-modify-write
 * races between concurrent chunk writers. The leaf-hash metadata lets
 * `completeUpload` build the merkle tree from HEAD requests — chunk bytes are
 * read back only if a chunk is missing its hash header.
 *
 * Recommended defense-in-depth: a native lifecycle rule on `{prefix}uploads/`
 * (e.g. expire after 7 days) so orphaned sessions vanish even if
 * `cleanupExpiredUploads` never runs.
 */
export class S3TemporaryUploadStorage implements TemporaryUploadStorage {
  readonly type = "temporary-upload-storage" as const;

  readonly #s3: S3Http;
  readonly #prefix: string;
  readonly #uploadTimeoutMs: number;
  readonly #concurrency: number;

  constructor(
    configOrClient: S3Config | S3Http,
    options?: {
      /** Key prefix inside the bucket. Defaults to `teleportal/`. */
      prefix?: string;
      uploadTimeoutMs?: number;
      /** Parallel HEAD/GET fan-out during completion. Defaults to 8. */
      concurrency?: number;
    },
  ) {
    this.#s3 = configOrClient instanceof S3Http ? configOrClient : new S3Http(configOrClient);
    this.#prefix = options?.prefix ?? DEFAULT_PREFIX;
    this.#uploadTimeoutMs = options?.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
    this.#concurrency = options?.concurrency ?? 8;
  }

  get s3(): S3Http {
    return this.#s3;
  }

  #uploadPrefix(uploadId: string): string {
    return `${this.#prefix}uploads/${safeId(uploadId)}/`;
  }

  #sessionKey(uploadId: string): string {
    return `${this.#uploadPrefix(uploadId)}session.json`;
  }

  #chunkPrefix(uploadId: string): string {
    return `${this.#uploadPrefix(uploadId)}chunks/`;
  }

  #chunkKey(uploadId: string, chunkIndex: number): string {
    return `${this.#chunkPrefix(uploadId)}${chunkIndex}`;
  }

  async #getSession(uploadId: string): Promise<SessionJson | null> {
    const bytes = await this.#s3.getObject(this.#sessionKey(uploadId));
    if (!bytes) return null;
    return JSON.parse(new TextDecoder().decode(bytes)) as SessionJson;
  }

  async #putSession(session: SessionJson): Promise<void> {
    await this.#s3.putObject(
      this.#sessionKey(session.uploadId),
      new TextEncoder().encode(JSON.stringify(session)),
      { contentType: "application/json" },
    );
  }

  async beginUpload(uploadId: string, metadata: FileMetadata): Promise<void> {
    const existing = await this.#getSession(uploadId);
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
      // Re-PUT also bumps the object's LastModified = the session's activity.
      await this.#putSession({ ...existing, documentIds: [...documentIds] });
      return;
    }

    await this.#putSession({
      version: 1,
      uploadId,
      metadata: {
        ...metadata,
        lastModified: metadata.lastModified || Date.now(),
      },
      documentIds: [metadata.documentId],
      createdAt: Date.now(),
    });
  }

  async storeChunk(
    uploadId: string,
    chunkIndex: number,
    chunkData: Uint8Array,
    _proof: Uint8Array[],
  ): Promise<{ storedChunks: number }> {
    const sessionHead = await this.#s3.headObject(this.#sessionKey(uploadId));
    if (!sessionHead) {
      throw new Error(`Upload session ${uploadId} not found`);
    }

    const leafHash = toBase64(await computeLeafHash(chunkData));
    const chunkKey = this.#chunkKey(uploadId, chunkIndex);
    const existing = await this.#s3.headObject(chunkKey);
    if (existing) {
      // Refuse to overwrite an already-stored chunk with different bytes — a
      // content-addressed session id is guessable, so this guards against a
      // third party poisoning an in-flight upload. Identical bytes (equal
      // leaf hashes) are a harmless retransmit; leave storage untouched.
      const storedHash =
        existing.meta[LEAF_HASH_META] ??
        toBase64(await computeLeafHash((await this.#s3.getObject(chunkKey)) ?? new Uint8Array()));
      if (storedHash !== leafHash) {
        throw new Error(
          `Chunk ${chunkIndex} for upload ${uploadId} conflicts with already-stored data`,
        );
      }
      return { storedChunks: await this.#countChunks(uploadId) };
    }

    await this.#s3.putObject(chunkKey, chunkData, {
      meta: { [LEAF_HASH_META]: leafHash },
    });

    // Derive the count from actually-persisted objects (list-after-write is
    // strongly consistent on S3/R2/MinIO) instead of a racy session counter.
    return { storedChunks: await this.#countChunks(uploadId) };
  }

  async #countChunks(uploadId: string): Promise<number> {
    const { objects } = await this.#s3.listAll(this.#chunkPrefix(uploadId));
    return objects.length;
  }

  async getUploadProgress(uploadId: string): Promise<UploadProgress | null> {
    const session = await this.#getSession(uploadId);
    if (!session) return null;

    const chunkPrefix = this.#chunkPrefix(uploadId);
    const { objects } = await this.#s3.listAll(this.#uploadPrefix(uploadId));

    const chunks = new Map<number, boolean>();
    let bytesUploaded = 0;
    let lastActivity = 0;
    for (const object of objects) {
      lastActivity = Math.max(lastActivity, object.lastModified);
      if (!object.key.startsWith(chunkPrefix)) continue;
      const chunkIndex = Number.parseInt(object.key.slice(chunkPrefix.length), 10);
      if (chunkIndex >= 0) {
        chunks.set(chunkIndex, true);
        bytesUploaded += object.size;
      }
    }

    return {
      metadata: session.metadata,
      chunks,
      merkleTree: null as MerkleTree | null,
      bytesUploaded,
      lastActivity,
    };
  }

  async completeUpload(
    uploadId: string,
    totalChunks: number,
    fileId?: File["id"],
  ): Promise<FileUploadResult> {
    const session = await this.#getSession(uploadId);
    if (!session) {
      throw new Error(`Upload session ${uploadId} not found`);
    }
    const progress = (await this.getUploadProgress(uploadId))!;
    const documentIds = session.documentIds ?? [session.metadata.documentId];

    for (let i = 0; i < totalChunks; i++) {
      if (!progress.chunks.get(i)) {
        throw new Error(`Missing chunk ${i} for upload ${uploadId}`);
      }
    }

    // Build the tree from the leaf hashes stored as chunk metadata: HEAD
    // requests move ~0 bytes, versus re-downloading every chunk. Chunks
    // written by older code without the header fall back to GET + hash.
    const leafHashes = await mapLimit(
      Array.from({ length: totalChunks }, (_, i) => i),
      this.#concurrency,
      async (i) => {
        const chunkKey = this.#chunkKey(uploadId, i);
        const head = await this.#s3.headObject(chunkKey);
        const encoded = head?.meta[LEAF_HASH_META];
        if (encoded) return fromBase64(encoded);
        const bytes = await this.#s3.getObject(chunkKey);
        if (!bytes) {
          throw new Error(`Chunk ${i} not found for upload ${uploadId}`);
        }
        return computeLeafHash(bytes);
      },
    );

    const merkleTree = buildMerkleTreeFromLeafHashes(leafHashes);
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

    // Chunks are NOT deleted here; the server calls deleteUpload after the
    // durable store succeeds, so a failed store stays retriable.
    const result: FileUploadResult = {
      progress,
      fileId: fileId ?? computedFileId,
      contentId: rootHash,
      totalChunks,
      documentIds,
      serializedMerkleTree: serializeMerkleTree(merkleTree),
      getChunk: async (chunkIndex: number) => {
        const bytes = await this.#s3.getObject(this.#chunkKey(uploadId, chunkIndex));
        if (!bytes) {
          throw new Error(`Chunk ${chunkIndex} not found for upload ${uploadId}`);
        }
        return bytes;
      },
    };
    Object.defineProperty(result, S3_UPLOAD_INTERNAL, {
      enumerable: false,
      value: {
        client: this.#s3,
        chunkKey: (chunkIndex: number) => this.#chunkKey(uploadId, chunkIndex),
        totalChunks,
      } satisfies S3UploadInternal,
    });
    return result;
  }

  async deleteUpload(uploadId: string): Promise<void> {
    const { objects } = await this.#s3.listAll(this.#uploadPrefix(uploadId));
    if (objects.length > 0) {
      await this.#s3.deleteObjects(objects.map((o) => o.key));
    }
  }

  async cleanupExpiredUploads(): Promise<void> {
    const now = Date.now();
    const { commonPrefixes } = await this.#s3.listAll(`${this.#prefix}uploads/`, {
      delimiter: "/",
    });
    for (const uploadPrefix of commonPrefixes) {
      const { objects } = await this.#s3.listAll(uploadPrefix);
      if (objects.length === 0) continue;
      const lastActivity = Math.max(...objects.map((o: S3ObjectInfo) => o.lastModified));
      if (now - lastActivity > this.#uploadTimeoutMs) {
        await this.#s3.deleteObjects(objects.map((o: S3ObjectInfo) => o.key));
      }
    }
  }
}
