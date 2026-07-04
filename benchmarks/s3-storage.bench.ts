/**
 * S3 storage adapter benchmarks. Requires a reachable S3-compatible endpoint
 * (docker run -p 9000:9000 minio/minio server /data); skips cleanly
 * otherwise. Run via `bun run bench:s3`.
 *
 * Design claims validated here:
 * - completeUpload's HEAD-based tree build beats re-downloading chunk bytes
 * - the server-side CopyObject promotion beats the generic GET+PUT loop
 * - bounded-parallel getFile scales with the concurrency setting
 *
 * Baseline (2026-07, M-series laptop, dockerized MinIO on localhost — real
 * S3/R2 network latency widens every gap below):
 *   storeChunk 256KB (hash+put+count)   ~11ms p50
 *   completeUpload 8 chunks             HEAD path ~2.2ms vs GET fallback ~4.6ms (2.1x)
 *   storeFileFromUpload 2MB             copy ~28ms vs generic GET+PUT ~72ms (2.4x)
 *   getFile 4MB/16 chunks p50           conc 1 ~9.2ms / 4 ~4.4ms / 8 ~3.5ms / 16 ~3.5ms
 *   (plateaus at ~8 → the default concurrency)
 */

import { afterAll, beforeAll, describe, it } from "bun:test";
import { toBase64 } from "teleportal/utils";
import { buildMerkleTree } from "teleportal/merkle-tree";

import type { FileMetadata } from "../src/storage/types";
import { InMemoryTemporaryUploadStorage } from "../src/storage/in-memory/temporary-upload-storage";
import { S3Http } from "../src/storage/s3/client";
import { S3FileStorage } from "../src/storage/s3/file-storage";
import { S3TemporaryUploadStorage, safeId } from "../src/storage/s3/temporary-upload-storage";
import { TEST_S3_CONFIG, isS3Available, randomS3Prefix } from "../src/storage/s3/test-utils";
import { bench, formatBytes } from "./helpers";

let available = false;
let client: S3Http;
const prefix = randomS3Prefix();

const CHUNK_BYTES = 256 * 1024;

function makeMetadata(size: number): FileMetadata {
  return {
    filename: "bench.bin",
    size,
    mimeType: "application/octet-stream",
    encrypted: false,
    lastModified: Date.now(),
    documentId: "bench-doc",
  };
}

function makeChunks(count: number, size = CHUNK_BYTES): Uint8Array[] {
  return Array.from({ length: count }, (_, i) => {
    const chunk = new Uint8Array(size);
    chunk.fill(i + 1);
    // Distinct random head so content ids differ between runs.
    crypto.getRandomValues(chunk.subarray(0, 64));
    return chunk;
  });
}

async function uploadChunks(temp: S3TemporaryUploadStorage, chunks: Uint8Array[]) {
  const fileId = toBase64((await buildMerkleTree(chunks)).nodes.at(-1)!.hash!);
  await temp.beginUpload(fileId, makeMetadata(chunks.reduce((s, c) => s + c.length, 0)));
  for (const [i, chunk] of chunks.entries()) {
    await temp.storeChunk(fileId, i, chunk, []);
  }
  return fileId;
}

beforeAll(async () => {
  available = await isS3Available();
  if (!available) {
    console.log("Skipping S3 benchmarks - no S3 endpoint available");
    return;
  }
  client = new S3Http(TEST_S3_CONFIG);
});

afterAll(async () => {
  if (!available) return;
  const { objects } = await client.listAll(prefix);
  if (objects.length > 0) {
    await client.deleteObjects(objects.map((o) => o.key));
  }
});

describe("S3 Storage Benchmarks", () => {
  it("storeChunk throughput", async () => {
    if (!available) return;
    const temp = new S3TemporaryUploadStorage(client, { prefix: `${prefix}chunks/` });
    const chunk = makeChunks(1)[0];
    const uploadId = "bench-store-chunk";
    await temp.beginUpload(uploadId, makeMetadata(chunk.length));

    let i = 0;
    await bench(`storeChunk (${formatBytes(CHUNK_BYTES)}, hash+put+count)`, () =>
      temp.storeChunk(uploadId, i++, chunk, []));
  });

  it("completeUpload: HEAD-path vs forced GET-fallback", async () => {
    if (!available) return;
    const chunkCount = 8;
    const temp = new S3TemporaryUploadStorage(client, { prefix: `${prefix}complete/` });
    const chunks = makeChunks(chunkCount);
    const fileId = await uploadChunks(temp, chunks);

    // Same bytes stored WITHOUT the leaf-hash metadata header, forcing
    // completeUpload to download and hash every chunk.
    const bare = new S3TemporaryUploadStorage(client, { prefix: `${prefix}complete-bare/` });
    await bare.beginUpload(fileId, makeMetadata(chunks.reduce((s, c) => s + c.length, 0)));
    for (const [i, chunk] of chunks.entries()) {
      await client.putObject(`${prefix}complete-bare/uploads/${safeId(fileId)}/chunks/${i}`, chunk);
    }

    await bench(`completeUpload (${chunkCount} chunks, HEAD leaf hashes)`, () =>
      temp.completeUpload(fileId, chunkCount, fileId));
    await bench(`completeUpload (${chunkCount} chunks, GET fallback)`, () =>
      bare.completeUpload(fileId, chunkCount, fileId));
  });

  it("storeFileFromUpload: server-side copy vs generic GET+PUT", async () => {
    if (!available) return;
    const chunkCount = 8;
    const chunks = makeChunks(chunkCount);
    const totalBytes = chunks.reduce((s, c) => s + c.length, 0);

    // Fast path: S3 temp storage sharing the bucket.
    const temp = new S3TemporaryUploadStorage(client, { prefix: `${prefix}promote/` });
    const files = new S3FileStorage(client, { prefix: `${prefix}promote/` });
    const fileId = await uploadChunks(temp, chunks);
    const fastResult = await temp.completeUpload(fileId, chunkCount, fileId);

    // Generic path: foreign (in-memory) temp storage, bytes transit the app.
    const memTemp = new InMemoryTemporaryUploadStorage();
    await memTemp.beginUpload(fileId, makeMetadata(totalBytes));
    for (const [i, chunk] of chunks.entries()) {
      await memTemp.storeChunk(fileId, i, chunk, []);
    }
    const genericResult = await memTemp.completeUpload(fileId, chunkCount, fileId);

    // Delete the manifest between iterations so dedup doesn't short-circuit.
    await bench(
      `storeFileFromUpload (${formatBytes(totalBytes)}, server-side copy)`,
      () => files.storeFileFromUpload(fastResult),
      { afterEach: () => files.deleteFile(fileId) },
    );
    await bench(
      `storeFileFromUpload (${formatBytes(totalBytes)}, generic GET+PUT)`,
      () => files.storeFileFromUpload(genericResult),
      { afterEach: () => files.deleteFile(fileId) },
    );
  });

  it("getFile chunk-fetch concurrency sweep", async () => {
    if (!available) return;
    const chunkCount = 16;
    const chunks = makeChunks(chunkCount);
    const temp = new S3TemporaryUploadStorage(client, { prefix: `${prefix}getfile/` });
    const store = new S3FileStorage(client, { prefix: `${prefix}getfile/` });
    const fileId = await uploadChunks(temp, chunks);
    const result = await temp.completeUpload(fileId, chunkCount, fileId);
    await store.storeFileFromUpload(result);
    const totalBytes = chunks.reduce((s, c) => s + c.length, 0);

    for (const concurrency of [1, 4, 8, 16]) {
      const reader = new S3FileStorage(client, { prefix: `${prefix}getfile/`, concurrency });
      await bench(
        `getFile (${formatBytes(totalBytes)} in ${chunkCount} chunks, concurrency ${concurrency})`,
        () => reader.getFile(fileId),
        { time: 1000 },
      );
    }
  });
});
