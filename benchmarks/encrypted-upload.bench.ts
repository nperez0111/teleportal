import { describe, it } from "bun:test";
import {
  buildMerkleTree,
  processFile,
  CHUNK_SIZE,
  ENCRYPTED_CHUNK_SIZE,
} from "../src/merkle-tree/merkle-tree";
import { InMemoryFileStorage } from "../src/storage/in-memory/file-storage";
import { InMemoryTemporaryUploadStorage } from "../src/storage/in-memory/temporary-upload-storage";
import type { FileMetadata } from "../src/storage/types";
import { createEncryptionKey, encryptUpdate, decryptUpdate } from "../src/encryption-key";
import { toBase64 } from "lib0/buffer";
import { bench, benchBatch, formatBytes, formatDuration } from "./helpers";

/**
 * Create a realistic File from a Blob of random data, exactly as a user
 * would upload via `<input type="file">` or drag-and-drop.
 */
function makeFile(size: number, name = "bench-file.bin"): File {
  const data = new Uint8Array(size);
  crypto.getRandomValues(data);
  return new File([data], name, { type: "application/octet-stream" });
}

function makeChunks(fileSize: number, chunkSize = CHUNK_SIZE): Uint8Array[] {
  const count = Math.max(1, Math.ceil(fileSize / chunkSize));
  const chunks: Uint8Array[] = [];
  let remaining = fileSize;
  for (let i = 0; i < count; i++) {
    const size = Math.min(chunkSize, remaining);
    const chunk = new Uint8Array(size);
    crypto.getRandomValues(chunk);
    chunks.push(chunk);
    remaining -= size;
  }
  return chunks;
}

function makeMetadata(fileSize: number, encrypted: boolean): FileMetadata {
  return {
    filename: "bench-file.bin",
    size: fileSize,
    mimeType: "application/octet-stream",
    encrypted,
    lastModified: Date.now(),
    documentId: "bench-doc",
  };
}

function encryptedStoredSize(fileSize: number): number {
  const chunkCount = Math.ceil(fileSize / ENCRYPTED_CHUNK_SIZE);
  return fileSize + chunkCount * (CHUNK_SIZE - ENCRYPTED_CHUNK_SIZE);
}

describe("Encrypted Upload Benchmarks", () => {
  // ── Encryption Primitive ──────────────────────────────────────────────

  describe("AES-256-GCM encrypt/decrypt (isolated)", () => {
    it("encrypt single chunk - various sizes", async () => {
      const keyResolver = createEncryptionKey();
      const key = await keyResolver.resolve({ document: "test-doc", connection: {} as any });

      for (const size of [1024, 16 * 1024, ENCRYPTED_CHUNK_SIZE, CHUNK_SIZE]) {
        const data = new Uint8Array(size);
        crypto.getRandomValues(data);

        await bench(`encrypt (${formatBytes(size)})`, () => encryptUpdate(key, data), {
          iterations: 200,
        });
      }
    });

    it("encrypt throughput - batch of chunks", async () => {
      const keyResolver = createEncryptionKey();
      const key = await keyResolver.resolve({ document: "test-doc", connection: {} as any });
      const batchSize = 100;
      const chunk = new Uint8Array(ENCRYPTED_CHUNK_SIZE);
      crypto.getRandomValues(chunk);

      await benchBatch(
        `encrypt ×${batchSize} (${formatBytes(ENCRYPTED_CHUNK_SIZE)} each)`,
        async () => {
          for (let i = 0; i < batchSize; i++) {
            await encryptUpdate(key, chunk);
          }
        },
        { batchSize, iterations: 5 },
      );
    });

    it("encrypt sequential vs parallel", async () => {
      const keyResolver = createEncryptionKey();
      const key = await keyResolver.resolve({ document: "test-doc", connection: {} as any });
      const chunkCount = 16;
      const chunks = makeChunks(chunkCount * ENCRYPTED_CHUNK_SIZE, ENCRYPTED_CHUNK_SIZE);

      await bench(
        `encrypt ${chunkCount} chunks sequential`,
        async () => {
          for (const chunk of chunks) {
            await encryptUpdate(key, chunk);
          }
        },
        { iterations: 50 },
      );

      await bench(
        `encrypt ${chunkCount} chunks parallel (Promise.all)`,
        async () => {
          await Promise.all(chunks.map((chunk) => encryptUpdate(key, chunk)));
        },
        { iterations: 50 },
      );
    });
  });

  // ── encryptUpdate internals ───────────────────────────────────────────

  describe("encryptUpdate overhead analysis", () => {
    it("raw crypto.subtle.encrypt vs encryptUpdate wrapper", async () => {
      const keyResolver = createEncryptionKey();
      const key = await keyResolver.resolve({ document: "test-doc", connection: {} as any });
      const data = new Uint8Array(ENCRYPTED_CHUNK_SIZE);
      crypto.getRandomValues(data);

      await bench("encryptUpdate wrapper", () => encryptUpdate(key, data), { iterations: 500 });

      await bench(
        "raw crypto.subtle.encrypt + IV concat",
        async () => {
          const iv = crypto.getRandomValues(new Uint8Array(12));
          const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
          const result = new Uint8Array(12 + encrypted.byteLength);
          result.set(iv, 0);
          result.set(new Uint8Array(encrypted), 12);
        },
        { iterations: 500 },
      );

      await bench(
        "crypto.subtle.encrypt only (no concat)",
        async () => {
          const iv = crypto.getRandomValues(new Uint8Array(12));
          await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
        },
        { iterations: 500 },
      );
    });
  });

  // ── processFile with File.stream() ─────────────────────────────────

  describe("processFile (File.stream())", () => {
    it("encrypted - various sizes", async () => {
      const keyResolver = createEncryptionKey();
      const key = await keyResolver.resolve({ document: "test-doc", connection: {} as any });

      for (const sizeMB of [0.1, 1, 5, 30]) {
        const file = makeFile(sizeMB * 1024 * 1024);
        const iters = sizeMB >= 30 ? 3 : sizeMB >= 5 ? 3 : 10;

        await bench(
          `processFile encrypted (${sizeMB}MB)`,
          async () => {
            await processFile(file.stream(), file.size, (chunk) => encryptUpdate(key, chunk));
          },
          { iterations: iters },
        );
      }
    });

    it("unencrypted - various sizes", async () => {
      for (const sizeMB of [1, 30]) {
        const file = makeFile(sizeMB * 1024 * 1024);
        const iters = sizeMB >= 30 ? 3 : 10;

        await bench(
          `processFile unencrypted (${sizeMB}MB)`,
          async () => {
            await processFile(file.stream(), file.size);
          },
          { iterations: iters },
        );
      }
    });
  });

  // ── Full encrypted upload pipeline ────────────────────────────────────

  describe("Full encrypted upload (File → chunk → encrypt → tree → store)", () => {
    it("encrypted upload - various sizes", async () => {
      const keyResolver = createEncryptionKey();
      const key = await keyResolver.resolve({ document: "test-doc", connection: {} as any });

      for (const sizeMB of [0.064, 0.5, 1, 5, 30]) {
        const file = makeFile(sizeMB * 1024 * 1024);
        const chunkCount = Math.ceil(file.size / ENCRYPTED_CHUNK_SIZE);
        const storedSize = encryptedStoredSize(file.size);
        const iters = sizeMB >= 30 ? 3 : sizeMB >= 5 ? 3 : 10;

        console.log(
          `    ${sizeMB}MB → ${chunkCount} encrypted chunks (${formatBytes(storedSize)} on disk)`,
        );

        await bench(
          `full encrypted upload (${sizeMB}MB)`,
          async () => {
            const temp = new InMemoryTemporaryUploadStorage();
            const fileStorage = new InMemoryFileStorage({ temporaryUploadStorage: temp });

            const uploadId = `upload-${Math.random()}`;
            await temp.beginUpload(uploadId, makeMetadata(storedSize, true));

            const parts = await processFile(file.stream(), file.size, (chunk) =>
              encryptUpdate(key, chunk),
            );
            const fileId = toBase64(parts.at(-1)!.rootHash);
            for (const part of parts) {
              await temp.storeChunk(uploadId, part.chunkIndex, part.chunkData, part.merkleProof);
            }
            const result = await temp.completeUpload(uploadId, parts.length, fileId);
            await fileStorage.storeFileFromUpload(result);
          },
          { iterations: iters },
        );
      }
    });

    it("encrypted vs unencrypted upload overhead (1MB File)", async () => {
      const keyResolver = createEncryptionKey();
      const key = await keyResolver.resolve({ document: "test-doc", connection: {} as any });
      const file = makeFile(1 * 1024 * 1024);

      const r1 = await bench(
        "upload unencrypted (1MB File)",
        async () => {
          const temp = new InMemoryTemporaryUploadStorage();
          const fileStorage = new InMemoryFileStorage({ temporaryUploadStorage: temp });

          const parts = await processFile(file.stream(), file.size);
          const fileId = toBase64(parts.at(-1)!.rootHash);

          await temp.beginUpload("upload", makeMetadata(file.size, false));
          for (const part of parts) {
            await temp.storeChunk("upload", part.chunkIndex, part.chunkData, part.merkleProof);
          }
          const result = await temp.completeUpload("upload", parts.length, fileId);
          await fileStorage.storeFileFromUpload(result);
        },
        { iterations: 10 },
      );

      const storedSize = encryptedStoredSize(file.size);
      const r2 = await bench(
        "upload encrypted (1MB File)",
        async () => {
          const temp = new InMemoryTemporaryUploadStorage();
          const fileStorage = new InMemoryFileStorage({ temporaryUploadStorage: temp });

          const uploadId = `upload-${Math.random()}`;
          await temp.beginUpload(uploadId, makeMetadata(storedSize, true));

          const parts = await processFile(file.stream(), file.size, (chunk) =>
            encryptUpdate(key, chunk),
          );
          const fileId = toBase64(parts.at(-1)!.rootHash);
          for (const part of parts) {
            await temp.storeChunk(uploadId, part.chunkIndex, part.chunkData, part.merkleProof);
          }
          const result = await temp.completeUpload(uploadId, parts.length, fileId);
          await fileStorage.storeFileFromUpload(result);
        },
        { iterations: 10 },
      );

      const overhead = ((r2.avgMs - r1.avgMs) / r1.avgMs) * 100;
      console.log(
        `\n    Encryption overhead: ${formatDuration(r2.avgMs - r1.avgMs)} (+${overhead.toFixed(1)}%)`,
      );
    });
  });

  // ── Pipeline stage breakdown (30MB File) ──────────────────────────────

  describe("Upload pipeline stage breakdown (30MB File)", () => {
    it("stage: File.stream() read only", async () => {
      const file = makeFile(30 * 1024 * 1024);

      await bench(
        "File.stream() read (30MB)",
        async () => {
          const reader = file.stream().getReader();
          while (true) {
            const { done } = await reader.read();
            if (done) break;
          }
        },
        { iterations: 5 },
      );
    });

    it("stage: encrypt only", async () => {
      const keyResolver = createEncryptionKey();
      const key = await keyResolver.resolve({ document: "test-doc", connection: {} as any });
      const fileSize = 30 * 1024 * 1024;
      const chunkCount = Math.ceil(fileSize / ENCRYPTED_CHUNK_SIZE);
      const chunks = makeChunks(chunkCount * ENCRYPTED_CHUNK_SIZE, ENCRYPTED_CHUNK_SIZE);

      console.log(`    ${chunkCount} chunks × ${formatBytes(ENCRYPTED_CHUNK_SIZE)}`);

      await bench(
        `encrypt ${chunkCount} chunks sequential`,
        async () => {
          for (const chunk of chunks) {
            await encryptUpdate(key, chunk);
          }
        },
        { iterations: 3 },
      );

      await bench(
        `encrypt ${chunkCount} chunks parallel (Promise.all)`,
        async () => {
          await Promise.all(chunks.map((chunk) => encryptUpdate(key, chunk)));
        },
        { iterations: 3 },
      );
    });

    it("stage: merkle tree build only", async () => {
      const fileSize = 30 * 1024 * 1024;
      const chunkCount = Math.ceil(fileSize / CHUNK_SIZE);
      const chunks = makeChunks(chunkCount * CHUNK_SIZE);

      await bench(`buildMerkleTree (${chunkCount} chunks, 30MB)`, () => buildMerkleTree(chunks), {
        iterations: 10,
      });
    });

    it("stage: storage write only", async () => {
      const fileSize = 30 * 1024 * 1024;
      const chunkCount = Math.ceil(fileSize / CHUNK_SIZE);
      const chunks = makeChunks(chunkCount * CHUNK_SIZE);

      await benchBatch(
        `storeChunk ×${chunkCount} (30MB)`,
        async () => {
          const temp = new InMemoryTemporaryUploadStorage();
          await temp.beginUpload("store", makeMetadata(chunkCount * CHUNK_SIZE, true));
          for (let i = 0; i < chunkCount; i++) {
            await temp.storeChunk("store", i, chunks[i], []);
          }
        },
        { batchSize: chunkCount, iterations: 5 },
      );
    });
  });

  // ── Optimization experiments ──────────────────────────────────────────

  describe("Optimization: parallel encrypt + sequential hash (30MB)", () => {
    it("pre-encrypt all chunks then build tree vs interleaved", async () => {
      const keyResolver = createEncryptionKey();
      const key = await keyResolver.resolve({ document: "test-doc", connection: {} as any });
      const fileSize = 30 * 1024 * 1024;
      const plainChunks = makeChunks(fileSize, ENCRYPTED_CHUNK_SIZE);
      console.log(`    ${plainChunks.length} chunks`);

      await bench(
        "interleaved: encrypt → hash → next (30MB)",
        async () => {
          const encrypted: Uint8Array[] = [];
          for (const chunk of plainChunks) {
            encrypted.push(await encryptUpdate(key, chunk));
          }
          await buildMerkleTree(encrypted);
        },
        { iterations: 3 },
      );

      await bench(
        "parallel encrypt all, then build tree (30MB)",
        async () => {
          const encrypted = await Promise.all(
            plainChunks.map((chunk) => encryptUpdate(key, chunk)),
          );
          await buildMerkleTree(encrypted);
        },
        { iterations: 3 },
      );

      for (const batchN of [8, 16, 32, 64]) {
        await bench(
          `batched encrypt (${batchN} at a time) + tree (30MB)`,
          async () => {
            const encrypted: Uint8Array[] = [];
            for (let i = 0; i < plainChunks.length; i += batchN) {
              const batch = plainChunks.slice(i, i + batchN);
              const results = await Promise.all(batch.map((chunk) => encryptUpdate(key, chunk)));
              encrypted.push(...results);
            }
            await buildMerkleTree(encrypted);
          },
          { iterations: 3 },
        );
      }
    });
  });

  // ── End-to-end round-trip ─────────────────────────────────────────────

  describe("Full encrypted round-trip (upload + download)", () => {
    it("round-trip - various sizes", async () => {
      const keyResolver = createEncryptionKey();
      const key = await keyResolver.resolve({ document: "test-doc", connection: {} as any });

      for (const sizeMB of [0.1, 1, 30]) {
        const file = makeFile(sizeMB * 1024 * 1024);
        const storedSize = encryptedStoredSize(file.size);

        await bench(
          `round-trip encrypted (${sizeMB}MB)`,
          async () => {
            // Upload
            const temp = new InMemoryTemporaryUploadStorage();
            const fileStorage = new InMemoryFileStorage({ temporaryUploadStorage: temp });
            const uploadId = `upload-${Math.random()}`;
            await temp.beginUpload(uploadId, makeMetadata(storedSize, true));

            const parts = await processFile(file.stream(), file.size, (chunk) =>
              encryptUpdate(key, chunk),
            );
            const fileId = toBase64(parts.at(-1)!.rootHash);
            for (const part of parts) {
              await temp.storeChunk(uploadId, part.chunkIndex, part.chunkData, part.merkleProof);
            }
            const result = await temp.completeUpload(uploadId, parts.length, fileId);
            await fileStorage.storeFileFromUpload(result);

            // Download + decrypt
            const downloaded = await fileStorage.getFile(fileId);
            if (!downloaded) throw new Error("File not found");
            for (const chunk of downloaded.chunks) {
              await decryptUpdate(key, chunk);
            }
          },
          { iterations: sizeMB >= 30 ? 3 : sizeMB >= 1 ? 5 : 10 },
        );
      }
    });
  });
});
