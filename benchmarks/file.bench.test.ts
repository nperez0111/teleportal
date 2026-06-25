import { describe, it } from "bun:test";
import { toBase64 } from "lib0/buffer";
import {
  buildMerkleTree,
  generateMerkleProof,
  verifyMerkleProof,
  serializeMerkleTree,
  deserializeMerkleTree,
  createMerkleTreeTransformStream,
  CHUNK_SIZE,
} from "../src/merkle-tree/merkle-tree";
import { InMemoryFileStorage } from "../src/storage/in-memory/file-storage";
import { InMemoryTemporaryUploadStorage } from "../src/storage/in-memory/temporary-upload-storage";
import type { FileMetadata } from "../src/storage/types";
import { bench, benchBatch, formatBytes } from "./helpers";

function makeChunks(fileSize: number): Uint8Array[] {
  const count = Math.max(1, Math.ceil(fileSize / CHUNK_SIZE));
  const chunks: Uint8Array[] = [];
  let remaining = fileSize;
  for (let i = 0; i < count; i++) {
    const size = Math.min(CHUNK_SIZE, remaining);
    const chunk = new Uint8Array(size);
    crypto.getRandomValues(chunk);
    chunks.push(chunk);
    remaining -= size;
  }
  return chunks;
}

function makeMetadata(fileSize: number): FileMetadata {
  return {
    filename: "bench-file.bin",
    size: fileSize,
    mimeType: "application/octet-stream",
    encrypted: false,
    lastModified: Date.now(),
    documentId: "bench-doc",
  };
}

async function uploadFile(
  temp: InMemoryTemporaryUploadStorage,
  fileStorage: InMemoryFileStorage,
  chunks: Uint8Array[],
  fileSize: number,
) {
  const uploadId = `upload-${Math.random()}`;
  const merkleTree = buildMerkleTree(chunks);
  const fileId = toBase64(merkleTree.nodes.at(-1)!.hash!);

  await temp.beginUpload(uploadId, makeMetadata(fileSize));
  for (let i = 0; i < chunks.length; i++) {
    await temp.storeChunk(uploadId, i, chunks[i], []);
  }
  const result = await temp.completeUpload(uploadId, fileId);
  await fileStorage.storeFileFromUpload(result);
  return fileId;
}

describe("File Upload & Download Benchmarks", () => {
  describe("Merkle Tree", () => {
    it("buildMerkleTree - various chunk counts", async () => {
      for (const count of [1, 10, 100, 1000]) {
        const chunks = makeChunks(count * CHUNK_SIZE);
        console.log(`    ${count} chunks → ${formatBytes(count * CHUNK_SIZE)}`);
        await bench(
          `buildMerkleTree (${count} chunks)`,
          () => { buildMerkleTree(chunks); },
          { iterations: count > 100 ? 20 : 100 },
        );
      }
    });

    it("generateMerkleProof", async () => {
      const chunks = makeChunks(100 * CHUNK_SIZE);
      const tree = buildMerkleTree(chunks);

      let i = 0;
      await bench(
        "generateMerkleProof (100-chunk tree)",
        () => { generateMerkleProof(tree, i++ % 100); },
        { iterations: 1000 },
      );
    });

    it("verifyMerkleProof", async () => {
      const chunks = makeChunks(100 * CHUNK_SIZE);
      const tree = buildMerkleTree(chunks);
      const root = tree.nodes.at(-1)!.hash!;
      const proofs = chunks.map((_, i) => generateMerkleProof(tree, i));

      let i = 0;
      await bench(
        "verifyMerkleProof (100-chunk tree)",
        () => {
          const idx = i++ % 100;
          verifyMerkleProof(chunks[idx], proofs[idx], root, idx);
        },
        { iterations: 1000 },
      );
    });

    it("serialize + deserialize merkle tree", async () => {
      const chunks = makeChunks(100 * CHUNK_SIZE);
      const tree = buildMerkleTree(chunks);

      await bench(
        "serializeMerkleTree (100 chunks)",
        () => { serializeMerkleTree(tree); },
        { iterations: 500 },
      );

      const serialized = serializeMerkleTree(tree);
      console.log(`    serialized size: ${formatBytes(serialized.byteLength)}`);

      await bench(
        "deserializeMerkleTree (100 chunks)",
        () => { deserializeMerkleTree(serialized, 100); },
        { iterations: 500 },
      );
    });

    it("createMerkleTreeTransformStream vs plain function", async () => {
      for (const sizeMB of [0.1, 1, 10]) {
        const fileSize = Math.floor(sizeMB * 1024 * 1024);
        const data = new Uint8Array(fileSize);
        crypto.getRandomValues(data);
        const iters = sizeMB >= 10 ? 5 : 20;

        await bench(
          `transformStream (${sizeMB}MB)`,
          async () => {
            const stream = createMerkleTreeTransformStream(fileSize);
            const writer = stream.writable.getWriter();

            const drain = (async () => {
              const reader = stream.readable.getReader();
              while (true) {
                const { done } = await reader.read();
                if (done) break;
              }
            })();

            let offset = 0;
            while (offset < fileSize) {
              const end = Math.min(offset + CHUNK_SIZE, fileSize);
              await writer.write(data.subarray(offset, end));
              offset = end;
            }
            await writer.close();
            await drain;
          },
          { iterations: iters },
        );

        await bench(
          `plain chunk+tree+proofs (${sizeMB}MB)`,
          () => {
            const chunks: Uint8Array[] = [];
            let offset = 0;
            while (offset < fileSize) {
              const end = Math.min(offset + CHUNK_SIZE, fileSize);
              chunks.push(data.subarray(offset, end));
              offset = end;
            }
            const tree = buildMerkleTree(chunks);
            for (let i = 0; i < chunks.length; i++) {
              generateMerkleProof(tree, i);
            }
          },
          { iterations: iters },
        );
      }
    });
  });

  describe("Upload Pipeline", () => {
    it("beginUpload", async () => {
      const temp = new InMemoryTemporaryUploadStorage();
      let i = 0;
      await bench(
        "beginUpload",
        () => temp.beginUpload(`upload-${i++}`, makeMetadata(1024)),
        { iterations: 1000 },
      );
    });

    it("storeChunk - single chunk", async () => {
      const temp = new InMemoryTemporaryUploadStorage();
      const chunk = new Uint8Array(CHUNK_SIZE);
      crypto.getRandomValues(chunk);

      await temp.beginUpload("store-bench", makeMetadata(CHUNK_SIZE));

      await bench(
        `storeChunk (${formatBytes(CHUNK_SIZE)})`,
        async () => {
          await temp.storeChunk("store-bench", 0, chunk, []);
        },
        { iterations: 500 },
      );
    });

    it("full upload - small file (single chunk)", async () => {
      const temp = new InMemoryTemporaryUploadStorage();
      const fileStorage = new InMemoryFileStorage({ temporaryUploadStorage: temp });

      const fileSize = 1024;
      const chunks = makeChunks(fileSize);

      await bench(
        `full upload (${formatBytes(fileSize)})`,
        async () => {
          await uploadFile(temp, fileStorage, chunks, fileSize);
        },
        { iterations: 200 },
      );
    });

    it("full upload - various sizes", async () => {
      for (const sizeMB of [0.064, 0.5, 1, 5]) {
        const fileSize = Math.floor(sizeMB * 1024 * 1024);
        const chunks = makeChunks(fileSize);
        const temp = new InMemoryTemporaryUploadStorage();
        const fileStorage = new InMemoryFileStorage({ temporaryUploadStorage: temp });

        console.log(`    ${sizeMB}MB → ${chunks.length} chunks`);
        await bench(
          `full upload (${sizeMB}MB, ${chunks.length} chunks)`,
          () => uploadFile(temp, fileStorage, chunks, fileSize),
          { iterations: sizeMB >= 5 ? 5 : 20 },
        );
      }
    });

    it("completeUpload (merkle build + validation)", async () => {
      for (const count of [1, 10, 100]) {
        const fileSize = count * CHUNK_SIZE;
        const chunks = makeChunks(fileSize);
        const merkleTree = buildMerkleTree(chunks);
        const fileId = toBase64(merkleTree.nodes.at(-1)!.hash!);

        await bench(
          `completeUpload (${count} chunks)`,
          async () => {
            const temp = new InMemoryTemporaryUploadStorage();
            const uploadId = `complete-${Math.random()}`;
            await temp.beginUpload(uploadId, makeMetadata(fileSize));
            for (let i = 0; i < chunks.length; i++) {
              await temp.storeChunk(uploadId, i, chunks[i], []);
            }
            await temp.completeUpload(uploadId, fileId);
          },
          { iterations: count > 50 ? 10 : 50 },
        );
      }
    });
  });

  describe("Download Pipeline", () => {
    it("getFile - various sizes", async () => {
      for (const sizeMB of [0.064, 1, 5]) {
        const fileSize = Math.floor(sizeMB * 1024 * 1024);
        const chunks = makeChunks(fileSize);
        const temp = new InMemoryTemporaryUploadStorage();
        const fileStorage = new InMemoryFileStorage({ temporaryUploadStorage: temp });
        const fileId = await uploadFile(temp, fileStorage, chunks, fileSize);

        await bench(
          `getFile (${sizeMB}MB)`,
          () => fileStorage.getFile(fileId),
          { iterations: 500 },
        );
      }
    });

    it("rebuild merkle tree + generate all proofs (download prep)", async () => {
      for (const count of [10, 100]) {
        const chunks = makeChunks(count * CHUNK_SIZE);

        await bench(
          `build tree + all proofs (${count} chunks)`,
          () => {
            const tree = buildMerkleTree(chunks);
            for (let i = 0; i < count; i++) {
              generateMerkleProof(tree, i);
            }
          },
          { iterations: count > 50 ? 10 : 50 },
        );
      }
    });

    it("full download simulation (getFile + verify all chunks)", async () => {
      for (const sizeMB of [0.064, 1]) {
        const fileSize = Math.floor(sizeMB * 1024 * 1024);
        const chunks = makeChunks(fileSize);
        const temp = new InMemoryTemporaryUploadStorage();
        const fileStorage = new InMemoryFileStorage({ temporaryUploadStorage: temp });
        const fileId = await uploadFile(temp, fileStorage, chunks, fileSize);

        await bench(
          `full download + verify (${sizeMB}MB)`,
          async () => {
            const file = await fileStorage.getFile(fileId);
            if (!file) throw new Error("File not found");
            const tree = buildMerkleTree(file.chunks);
            const root = tree.nodes.at(-1)!.hash!;
            for (let i = 0; i < file.chunks.length; i++) {
              const proof = generateMerkleProof(tree, i);
              verifyMerkleProof(file.chunks[i], proof, root, i);
            }
          },
          { iterations: 20 },
        );
      }
    });
  });

  describe("Chunk-level I/O", () => {
    it("storeChunk throughput", async () => {
      const chunk = new Uint8Array(CHUNK_SIZE);
      crypto.getRandomValues(chunk);

      const batchSize = 100;
      await benchBatch(
        `store ${batchSize} chunks (${formatBytes(CHUNK_SIZE)} each)`,
        async () => {
          const temp = new InMemoryTemporaryUploadStorage();
          await temp.beginUpload("throughput", makeMetadata(batchSize * CHUNK_SIZE));
          for (let i = 0; i < batchSize; i++) {
            await temp.storeChunk("throughput", i, chunk, []);
          }
        },
        { batchSize, iterations: 10 },
      );
    });

    it("getChunk throughput (from completed upload)", async () => {
      const count = 100;
      const fileSize = count * CHUNK_SIZE;
      const chunks = makeChunks(fileSize);
      const merkleTree = buildMerkleTree(chunks);
      const fileId = toBase64(merkleTree.nodes.at(-1)!.hash!);

      await benchBatch(
        `getChunk ×${count} (${formatBytes(CHUNK_SIZE)} each)`,
        async () => {
          const temp = new InMemoryTemporaryUploadStorage();
          await temp.beginUpload("getchunk", makeMetadata(fileSize));
          for (let i = 0; i < count; i++) {
            await temp.storeChunk("getchunk", i, chunks[i], []);
          }
          const result = await temp.completeUpload("getchunk", fileId);
          for (let i = 0; i < count; i++) {
            await result.getChunk(i);
          }
        },
        { batchSize: count, iterations: 10 },
      );
    });
  });
});
