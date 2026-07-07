import { fromBase64, toBase64 } from "teleportal/utils";

import type {
  File,
  FileMetadata,
  FileStorage,
  FileUploadResult,
  TemporaryUploadStorage,
} from "../types";
import { S3Error, S3Http, mapLimit, type S3Config } from "./client";
import { S3_UPLOAD_INTERNAL, safeId, type S3UploadInternal } from "./temporary-upload-storage";

const DEFAULT_PREFIX = "teleportal/";

type ManifestJson = {
  version: 1;
  fileId: string;
  metadata: FileMetadata;
  contentId: string;
  totalChunks: number;
};

/**
 * Durable file storage on S3/R2/MinIO, content-addressed by merkle root.
 *
 * Layout (all under `{prefix}files/{safeId(fileId)}/`):
 * - `manifest.json` — metadata + chunk count; written LAST as the commit
 *   point, so `getFile` never sees a partially stored file
 * - `tree` — serialized merkle tree as raw binary (no base64 inflation)
 * - `chunks/{i}` — raw chunk bytes
 *
 * `storeFileFromUpload` promotion, fastest to slowest:
 * 1. Dedup: the manifest already exists (same content hash) — store nothing.
 * 2. Server-side CopyObject per chunk, when the upload result came from an
 *    {@link S3TemporaryUploadStorage} on the same bucket — bytes never
 *    transit the app.
 * 3. Generic `getChunk` + PUT loop (one chunk in memory at a time), for any
 *    other TemporaryUploadStorage.
 */
export class S3FileStorage implements FileStorage {
  readonly type = "file-storage" as const;

  temporaryUploadStorage?: TemporaryUploadStorage;

  readonly #s3: S3Http;
  readonly #prefix: string;
  readonly #concurrency: number;

  constructor(
    configOrClient: S3Config | S3Http,
    options?: {
      /** Key prefix inside the bucket. Defaults to `teleportal/`. */
      prefix?: string;
      temporaryUploadStorage?: TemporaryUploadStorage;
      /** Parallel chunk fan-out for reads/copies. Defaults to 8. */
      concurrency?: number;
    },
  ) {
    this.#s3 = configOrClient instanceof S3Http ? configOrClient : new S3Http(configOrClient);
    this.#prefix = options?.prefix ?? DEFAULT_PREFIX;
    this.temporaryUploadStorage = options?.temporaryUploadStorage;
    this.#concurrency = options?.concurrency ?? 8;
  }

  get s3(): S3Http {
    return this.#s3;
  }

  #filePrefix(fileId: string): string {
    return `${this.#prefix}files/${safeId(fileId)}/`;
  }

  #manifestKey(fileId: string): string {
    return `${this.#filePrefix(fileId)}manifest.json`;
  }

  #treeKey(fileId: string): string {
    return `${this.#filePrefix(fileId)}tree`;
  }

  #chunkKey(fileId: string, chunkIndex: number): string {
    return `${this.#filePrefix(fileId)}chunks/${chunkIndex}`;
  }

  async #getManifest(fileId: string): Promise<ManifestJson | null> {
    const bytes = await this.#s3.getObject(this.#manifestKey(fileId));
    if (!bytes) return null;
    return JSON.parse(new TextDecoder().decode(bytes)) as ManifestJson;
  }

  async getFile(fileId: File["id"]): Promise<File | null> {
    const manifest = await this.#getManifest(fileId);
    if (!manifest) return null;

    // Tree + chunks fetched together with bounded parallelism. A missing
    // chunk is a hard error: silently dropping it would serve a corrupt file.
    const [tree, chunks] = await Promise.all([
      this.#s3.getObject(this.#treeKey(fileId)),
      mapLimit(
        Array.from({ length: manifest.totalChunks }, (_, i) => i),
        this.#concurrency,
        async (i) => {
          const bytes = await this.#s3.getObject(this.#chunkKey(fileId, i));
          if (!bytes) {
            throw new S3Error(
              "getFile",
              404,
              `chunk ${i} of file ${fileId} is missing from storage`,
              "NoSuchKey",
              this.#chunkKey(fileId, i),
            );
          }
          return bytes;
        },
      ),
    ]);

    return {
      id: fileId,
      metadata: manifest.metadata,
      chunks,
      contentId: fromBase64(manifest.contentId),
      serializedMerkleTree: tree ?? undefined,
    };
  }

  async deleteFile(fileId: File["id"]): Promise<void> {
    const manifest = await this.#getManifest(fileId);
    if (!manifest) return;
    // Manifest first: readers see the file as gone immediately, and chunk
    // keys are derived from totalChunks — no ListObjects required.
    await this.#s3.deleteObject(this.#manifestKey(fileId));
    const keys = [
      this.#treeKey(fileId),
      ...Array.from({ length: manifest.totalChunks }, (_, i) => this.#chunkKey(fileId, i)),
    ];
    await this.#s3.deleteObjects(keys);
  }

  /**
   * Store a fully materialized file (helper for composition; not part of the
   * `FileStorage` interface).
   */
  async storeFile(file: File): Promise<void> {
    await mapLimit(file.chunks, this.#concurrency, (chunk, i) =>
      this.#s3.putObject(this.#chunkKey(file.id, i), chunk),
    );
    if (file.serializedMerkleTree) {
      await this.#s3.putObject(this.#treeKey(file.id), file.serializedMerkleTree);
    }
    await this.#putManifest({
      version: 1,
      fileId: file.id,
      metadata: file.metadata,
      contentId: toBase64(file.contentId),
      totalChunks: file.chunks.length,
    });
  }

  async storeFileFromUpload(uploadResult: FileUploadResult): Promise<void> {
    const { fileId, totalChunks } = uploadResult;

    // Content-addressed dedup: the fileId IS the content hash, so an existing
    // manifest means the exact bytes are already durably stored.
    if (await this.#s3.headObject(this.#manifestKey(fileId))) {
      return;
    }

    const internal = (uploadResult as unknown as Record<PropertyKey, unknown>)[
      S3_UPLOAD_INTERNAL
    ] as S3UploadInternal | undefined;

    if (
      internal &&
      internal.client.bucket === this.#s3.bucket &&
      internal.client.endpoint === this.#s3.endpoint
    ) {
      // Fast path: chunks are already in this bucket (temporary upload
      // storage shares it) — promote with server-side copies.
      await mapLimit(
        Array.from({ length: totalChunks }, (_, i) => i),
        this.#concurrency,
        (i) => this.#s3.copyObject(internal.chunkKey(i), this.#chunkKey(fileId, i)),
      );
    } else {
      // Generic path: one chunk in memory at a time, works with any
      // TemporaryUploadStorage implementation.
      for (let i = 0; i < totalChunks; i++) {
        const chunk = await uploadResult.getChunk(i);
        await this.#s3.putObject(this.#chunkKey(fileId, i), chunk);
      }
    }

    await this.#s3.putObject(this.#treeKey(fileId), uploadResult.serializedMerkleTree);
    await this.#putManifest({
      version: 1,
      fileId,
      metadata: uploadResult.progress.metadata,
      contentId: toBase64(uploadResult.contentId),
      totalChunks,
    });
  }

  async #putManifest(manifest: ManifestJson): Promise<void> {
    await this.#s3.putObject(
      this.#manifestKey(manifest.fileId),
      new TextEncoder().encode(JSON.stringify(manifest)),
      { contentType: "application/json" },
    );
  }
}
