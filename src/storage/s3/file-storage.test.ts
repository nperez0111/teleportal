/**
 * Integration tests against a real S3-compatible endpoint (MinIO):
 *   docker run -p 9000:9000 minio/minio server /data
 * Skipped automatically when no endpoint is reachable.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { toBase64 } from "teleportal/utils";
import { CHUNK_SIZE, buildMerkleTree } from "teleportal/merkle-tree";

import type { FileMetadata } from "../types";
import { InMemoryTemporaryUploadStorage } from "../in-memory/temporary-upload-storage";
import { S3Http } from "./client";
import { S3FileStorage } from "./file-storage";
import { S3TemporaryUploadStorage, safeId } from "./temporary-upload-storage";
import { TEST_S3_CONFIG, isS3Available, randomS3Prefix } from "./test-utils";

let available = false;
let client: S3Http;
const prefix = randomS3Prefix();

function makeMetadata(overrides: Partial<FileMetadata> = {}): FileMetadata {
  return {
    filename: "test.txt",
    size: 6,
    mimeType: "text/plain",
    encrypted: false,
    lastModified: Date.now(),
    documentId: "test-doc",
    ...overrides,
  };
}

function makeStores(subPrefix: string, uploadTimeoutMs?: number) {
  const storePrefix = `${prefix}${subPrefix}/`;
  const temp = new S3TemporaryUploadStorage(client, {
    prefix: storePrefix,
    uploadTimeoutMs,
  });
  const files = new S3FileStorage(client, {
    prefix: storePrefix,
    temporaryUploadStorage: temp,
  });
  return { temp, files, storePrefix };
}

/** Upload chunks through the temp store and return the completed result. */
async function uploadChunks(
  temp: S3TemporaryUploadStorage,
  chunks: Uint8Array[],
  metadata: Partial<FileMetadata> = {},
) {
  const contentId = (await buildMerkleTree(chunks)).nodes.at(-1)!.hash!;
  const fileId = toBase64(contentId);
  await temp.beginUpload(
    fileId,
    makeMetadata({ size: chunks.reduce((s, c) => s + c.length, 0), ...metadata }),
  );
  for (const [i, chunk] of chunks.entries()) {
    await temp.storeChunk(fileId, i, chunk, []);
  }
  const result = await temp.completeUpload(fileId, chunks.length, fileId);
  return { result, fileId, contentId };
}

beforeAll(async () => {
  available = await isS3Available();
  if (!available) return;
  client = new S3Http(TEST_S3_CONFIG);
});

afterAll(async () => {
  if (!available) return;
  const { objects } = await client.listAll(prefix);
  if (objects.length > 0) {
    await client.deleteObjects(objects.map((o) => o.key));
  }
});

describe("S3FileStorage + S3TemporaryUploadStorage", () => {
  it("stores completed files and can retrieve them", async () => {
    if (!available) return;
    const { temp, files } = makeStores("roundtrip");
    const chunks = [new Uint8Array([1, 2, 3, 4, 5, 6])];
    const { result, fileId, contentId } = await uploadChunks(temp, chunks);
    await files.storeFileFromUpload(result);

    const file = await files.getFile(fileId);
    expect(file).not.toBeNull();
    expect(file!.id).toBe(fileId);
    expect(file!.metadata.filename).toBe("test.txt");
    expect(file!.chunks).toHaveLength(1);
    expect(file!.chunks[0]).toEqual(chunks[0]);
    expect(file!.contentId).toEqual(contentId);
    expect(file!.serializedMerkleTree).toEqual(result.serializedMerkleTree);
  });

  it("tracks upload progress and chunk completion", async () => {
    if (!available) return;
    const { temp } = makeStores("progress");
    const chunks = [new Uint8Array(1024).fill(1), new Uint8Array(1024).fill(2)];
    const fileId = toBase64((await buildMerkleTree(chunks)).nodes.at(-1)!.hash!);

    await temp.beginUpload(fileId, makeMetadata({ size: 2048 }));
    await temp.storeChunk(fileId, 0, chunks[0], []);

    const progress = await temp.getUploadProgress(fileId);
    expect(progress).not.toBeNull();
    expect(progress!.chunks.get(0)).toBe(true);
    expect(progress!.chunks.get(1)).toBeUndefined();
    expect(progress!.bytesUploaded).toBe(1024);
    expect(progress!.lastActivity).toBeGreaterThan(0);

    const { storedChunks } = await temp.storeChunk(fileId, 1, chunks[1], []);
    expect(storedChunks).toBe(2);
    await temp.completeUpload(fileId, chunks.length);
  });

  it("returns null progress for unknown uploads", async () => {
    if (!available) return;
    const { temp } = makeStores("unknown");
    expect(await temp.getUploadProgress("nope")).toBeNull();
  });

  it("rejects storeChunk for unknown sessions", async () => {
    if (!available) return;
    const { temp } = makeStores("nosession");
    await expect(temp.storeChunk("ghost", 0, new Uint8Array([1]), [])).rejects.toThrow(
      "Upload session ghost not found",
    );
  });

  it("treats identical re-sent chunks as retransmits but rejects conflicting bytes", async () => {
    if (!available) return;
    const { temp } = makeStores("poison");
    const chunks = [new Uint8Array([9, 9, 9])];
    const fileId = toBase64((await buildMerkleTree(chunks)).nodes.at(-1)!.hash!);
    await temp.beginUpload(fileId, makeMetadata({ size: 3 }));
    await temp.storeChunk(fileId, 0, chunks[0], []);

    // Identical bytes: harmless retransmit.
    const { storedChunks } = await temp.storeChunk(fileId, 0, chunks[0], []);
    expect(storedChunks).toBe(1);

    // Different bytes: poisoning attempt.
    await expect(temp.storeChunk(fileId, 0, new Uint8Array([6, 6, 6]), [])).rejects.toThrow(
      /conflicts with already-stored data/,
    );
  });

  it("merges documentIds across beginUpload calls and rejects conflicting metadata", async () => {
    if (!available) return;
    const { temp } = makeStores("docids");
    const chunks = [new Uint8Array([1])];
    const fileId = toBase64((await buildMerkleTree(chunks)).nodes.at(-1)!.hash!);

    await temp.beginUpload(fileId, makeMetadata({ size: 1, documentId: "doc-a" }));
    await temp.beginUpload(fileId, makeMetadata({ size: 1, documentId: "doc-b" }));
    await temp.storeChunk(fileId, 0, chunks[0], []);
    const result = await temp.completeUpload(fileId, 1, fileId);
    expect(result.documentIds.sort()).toEqual(["doc-a", "doc-b"]);

    await expect(temp.beginUpload(fileId, makeMetadata({ size: 999 }))).rejects.toThrow(
      /conflicting metadata/,
    );
  });

  it("fails completeUpload on missing chunks and on a merkle root mismatch", async () => {
    if (!available) return;
    const { temp } = makeStores("mismatch");
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];
    const fileId = toBase64((await buildMerkleTree(chunks)).nodes.at(-1)!.hash!);
    await temp.beginUpload(fileId, makeMetadata({ size: 4 }));
    await temp.storeChunk(fileId, 0, chunks[0], []);

    await expect(temp.completeUpload(fileId, 2, fileId)).rejects.toThrow(
      `Missing chunk 1 for upload ${fileId}`,
    );

    await temp.storeChunk(fileId, 1, chunks[1], []);
    await expect(temp.completeUpload(fileId, 2, "wrong-root")).rejects.toThrow(
      /Merkle root mismatch/,
    );
  });

  it("builds the same root from HEAD-read leaf hashes as from raw chunk bytes", async () => {
    if (!available) return;
    const { temp } = makeStores("headhash");
    // 3 chunks exercises the odd-count carry-up path.
    const chunks = [
      new Uint8Array(2048).fill(3),
      new Uint8Array(2048).fill(4),
      new Uint8Array(100).fill(5),
    ];
    // completeUpload validates its HEAD-derived root against this
    // locally-computed one, so passing fileId proves the equivalence.
    const { result, contentId } = await uploadChunks(temp, chunks);
    expect(result.contentId).toEqual(contentId);
  });

  it("keeps chunks fetchable via getChunk and cleans up only on deleteUpload", async () => {
    if (!available) return;
    const { temp, storePrefix } = makeStores("lifecycle");
    const chunks = [new Uint8Array([1, 1]), new Uint8Array([2, 2])];
    const { result, fileId } = await uploadChunks(temp, chunks);

    // Re-fetchable (idempotent, not one-time).
    expect(await result.getChunk(0)).toEqual(chunks[0]);
    expect(await result.getChunk(0)).toEqual(chunks[0]);
    expect(await result.getChunk(1)).toEqual(chunks[1]);

    await temp.deleteUpload(fileId);
    const { objects } = await client.listAll(`${storePrefix}uploads/`);
    expect(objects).toHaveLength(0);
    await expect(result.getChunk(0)).rejects.toThrow(/not found/);
  });

  it("cleans up expired uploads", async () => {
    if (!available) return;
    const { temp } = makeStores("expiry", 1);
    const fileId = "expiring-upload";
    await temp.beginUpload(fileId, makeMetadata({ size: 1024 }));
    // S3 LastModified has second granularity and floors, so any activity is
    // at least a few ms in the past by now — already beyond the 1ms timeout.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await temp.cleanupExpiredUploads();
    expect(await temp.getUploadProgress(fileId)).toBeNull();
  });

  it("keeps fresh uploads during cleanup", async () => {
    if (!available) return;
    const { temp } = makeStores("fresh", 60 * 60 * 1000);
    const fileId = "fresh-upload";
    await temp.beginUpload(fileId, makeMetadata({ size: 1024 }));
    await temp.cleanupExpiredUploads();
    expect(await temp.getUploadProgress(fileId)).not.toBeNull();
  });

  it("promotes via server-side copy without reading chunks through the app", async () => {
    if (!available) return;
    const { temp, files, storePrefix } = makeStores("fastpath");
    const chunks = [new Uint8Array(CHUNK_SIZE).fill(7), new Uint8Array([8])];
    const { result, fileId } = await uploadChunks(temp, chunks);

    let getChunkCalls = 0;
    const originalGetChunk = result.getChunk;
    result.getChunk = (i) => {
      getChunkCalls++;
      return originalGetChunk(i);
    };

    await files.storeFileFromUpload(result);
    // The same-bucket fast path copies server-side — no app-relayed bytes.
    expect(getChunkCalls).toBe(0);

    const file = await files.getFile(fileId);
    expect(file!.chunks).toHaveLength(2);
    expect(file!.chunks[0]).toEqual(chunks[0]);
    expect(file!.chunks[1]).toEqual(chunks[1]);

    // Temp chunks remain until the server calls deleteUpload (retriability).
    const { objects } = await client.listAll(`${storePrefix}uploads/`);
    expect(objects.length).toBeGreaterThan(0);
    await temp.deleteUpload(fileId);
  });

  it("skips storing entirely when the content already exists (dedup)", async () => {
    if (!available) return;
    const { temp, files } = makeStores("dedup");
    const chunks = [new Uint8Array([42, 42])];
    const { result, fileId } = await uploadChunks(temp, chunks);
    await files.storeFileFromUpload(result);

    let getChunkCalls = 0;
    const second = { ...result, getChunk: () => (getChunkCalls++, result.getChunk(0)) };
    Object.defineProperty(second, Symbol.for("teleportal.s3.upload-internal"), {
      value: undefined,
    });
    await files.storeFileFromUpload(second);
    // Without dedup the generic path would have called getChunk.
    expect(getChunkCalls).toBe(0);
    expect(await files.getFile(fileId)).not.toBeNull();
  });

  it("promotes from a foreign temporary storage via the generic path", async () => {
    if (!available) return;
    const { files } = makeStores("generic");
    const memTemp = new InMemoryTemporaryUploadStorage();
    const chunks = [new Uint8Array([5, 5, 5]), new Uint8Array([6, 6])];
    const contentId = (await buildMerkleTree(chunks)).nodes.at(-1)!.hash!;
    const fileId = toBase64(contentId);
    await memTemp.beginUpload(fileId, makeMetadata({ size: 5 }));
    for (const [i, chunk] of chunks.entries()) {
      await memTemp.storeChunk(fileId, i, chunk, []);
    }
    const result = await memTemp.completeUpload(fileId, chunks.length, fileId);
    await files.storeFileFromUpload(result);

    const file = await files.getFile(fileId);
    expect(file!.chunks).toHaveLength(2);
    expect(file!.chunks[0]).toEqual(chunks[0]);
    expect(file!.chunks[1]).toEqual(chunks[1]);
  });

  it("throws instead of returning a corrupt file when a chunk is missing", async () => {
    if (!available) return;
    const { temp, files, storePrefix } = makeStores("corrupt");
    const chunks = [new Uint8Array([1]), new Uint8Array([2])];
    const { result, fileId } = await uploadChunks(temp, chunks);
    await files.storeFileFromUpload(result);

    await client.deleteObject(`${storePrefix}files/${safeId(fileId)}/chunks/1`);
    await expect(files.getFile(fileId)).rejects.toThrow(/chunk 1 .* missing/);
  });

  it("round-trips file ids containing base64 special characters", async () => {
    if (!available) return;
    const { files } = makeStores("specialid");
    // Real fileIds are base64 merkle roots — 44 chars incl. `/`, `+`, `=`.
    const fileId = `${"a/b+".repeat(10)}abc=`;
    await files.storeFile({
      id: fileId,
      metadata: makeMetadata({ size: 3 }),
      chunks: [new Uint8Array([1, 2, 3])],
      contentId: new Uint8Array(32).fill(1),
    });
    const file = await files.getFile(fileId);
    expect(file).not.toBeNull();
    expect(file!.id).toBe(fileId);
    expect(file!.chunks[0]).toEqual(new Uint8Array([1, 2, 3]));
    // A different root (same length, different chars) must not collide.
    expect(await files.getFile(`${"a/b+".repeat(10)}abd=`)).toBeNull();
  });

  describe("deleteFile", () => {
    it("deletes the manifest, tree, and all chunks", async () => {
      if (!available) return;
      const { temp, files, storePrefix } = makeStores("delete");
      const chunks = [new Uint8Array([1, 2, 3])];
      const { result, fileId } = await uploadChunks(temp, chunks);
      await files.storeFileFromUpload(result);
      await temp.deleteUpload(fileId);

      await files.deleteFile(fileId);
      expect(await files.getFile(fileId)).toBeNull();
      const { objects } = await client.listAll(`${storePrefix}files/`);
      expect(objects).toHaveLength(0);
    });

    it("is a no-op for unknown files", async () => {
      if (!available) return;
      const { files } = makeStores("deletemissing");
      await files.deleteFile("does-not-exist");
    });
  });
});
