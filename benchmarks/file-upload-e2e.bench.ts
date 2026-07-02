import { describe, it } from "bun:test";
import { Server } from "../src/server/server";
import { MemoryDocumentStorage } from "../src/storage/in-memory/document-storage";
import { InMemoryFileStorage } from "../src/storage/in-memory/file-storage";
import { InMemoryTemporaryUploadStorage } from "../src/storage/in-memory/temporary-upload-storage";
import { UnstorageTemporaryUploadStorage } from "../src/storage/unstorage/temporary-upload-storage";
import { getFileRpcHandlers } from "../src/protocols/file";
import { InMemoryPubSub, type Message, type ServerContext, type Transport } from "teleportal";
import { createChannel } from "../src/lib/iter";
import { defaultRateLimitRules } from "../src/transports/rate-limiter";
import { createStorage } from "unstorage";
import { processFile, ENCRYPTED_CHUNK_SIZE, CHUNK_SIZE } from "../src/merkle-tree/merkle-tree";
import { createEncryptionKey, encryptUpdate } from "../src/encryption-key";
import { RpcMessage } from "../src/lib/protocol";
import { bench } from "./helpers";

// ---------------------------------------------------------------------------
// Transport that captures outbound messages for the benchmark
// ---------------------------------------------------------------------------

class BenchTransport<Context extends ServerContext> implements Transport<Context> {
  public source: AsyncIterable<Message<Context>[]>;
  #channel = createChannel<Message<Context>>();
  public outbound: Message<Context>[] = [];

  constructor() {
    this.source = this.#channel;
  }

  write(message: Message<Context>): void {
    this.outbound.push(message);
  }

  close(): void {}
  async destroy() {}

  enqueueMessage(message: Message<Context>) {
    try {
      this.#channel.send(message);
    } catch {}
  }

  closeReadable() {
    this.#channel.close();
  }

  [key: string]: unknown;
}

function makeFile(size: number): File {
  const data = new Uint8Array(size);
  crypto.getRandomValues(data);
  return new File([data], "bench-file.bin", { type: "application/octet-stream" });
}

function encryptedStoredSize(fileSize: number): number {
  const chunkCount = Math.ceil(fileSize / ENCRYPTED_CHUNK_SIZE);
  return fileSize + chunkCount * (CHUNK_SIZE - ENCRYPTED_CHUNK_SIZE);
}

async function setupServer(opts?: { useUnstorage?: boolean; withRateLimit?: boolean }) {
  const pubSub = new InMemoryPubSub();
  const docStorage = new MemoryDocumentStorage(false);

  const tempStorage = opts?.useUnstorage
    ? new UnstorageTemporaryUploadStorage(createStorage(), { keyPrefix: "file" })
    : new InMemoryTemporaryUploadStorage();

  const fileStorage = new InMemoryFileStorage({ temporaryUploadStorage: tempStorage });
  const fileHandlers = getFileRpcHandlers(fileStorage);

  const rateLimitConfig = opts?.withRateLimit
    ? {
        rules: defaultRateLimitRules(),
        getUserId: (m: any) => m.context?.userId,
        getDocumentId: (m: any) => m.document,
      }
    : undefined;

  const server = new Server<ServerContext>({
    storage: docStorage,
    pubSub,
    rpcHandlers: { ...fileHandlers },
    rateLimitConfig,
  });

  const transport = new BenchTransport<ServerContext>();
  const client = server.createClient({ transport });

  return { server, client, transport, fileStorage, tempStorage, pubSub };
}

async function uploadFile(
  transport: BenchTransport<ServerContext>,
  file: File,
  encryptionKey?: CryptoKey,
) {
  const document = "bench-doc";
  const context = { userId: "bench-user", room: "bench", clientId: "bench-client" };
  const encrypted = !!encryptionKey;
  const fileId = crypto.randomUUID();

  // 1. Send upload request (size is raw/plaintext file size)
  const uploadRequest = new RpcMessage(
    document,
    {
      type: "success",
      payload: {
        fileId,
        filename: file.name,
        size: file.size,
        mimeType: file.type,
        lastModified: file.lastModified,
        encrypted,
      },
    },
    "fileUpload",
    "request",
    undefined,
    context,
    encrypted,
  );
  transport.enqueueMessage(uploadRequest);

  // Wait for server to process the request
  await new Promise((r) => setTimeout(r, 1));

  // 2. Process file into parts
  const parts = await processFile(
    file.stream(),
    file.size,
    encryptionKey ? (chunk) => encryptUpdate(encryptionKey, chunk) : undefined,
  );

  // 3. Send all chunk stream messages
  for (const part of parts) {
    const streamMessage = new RpcMessage(
      document,
      {
        type: "success",
        payload: {
          fileId,
          chunkIndex: part.chunkIndex,
          chunkData: part.chunkData,
          merkleProof: part.merkleProof,
          totalChunks: part.totalChunks,
          bytesUploaded: part.bytesProcessed,
          encrypted,
        },
      },
      "fileUpload",
      "stream",
      uploadRequest.id,
      context,
      encrypted,
    );
    transport.enqueueMessage(streamMessage);
  }

  // Wait for server to process all chunks
  await new Promise((r) => setTimeout(r, 50));

  return { fileId, parts };
}

describe("File Upload E2E Benchmarks", () => {
  describe("Server-side chunk processing (in-memory storage)", () => {
    it("encrypted upload - various sizes", async () => {
      const key = await createEncryptionKey();

      for (const sizeMB of [1, 5, 30, 100]) {
        const file = makeFile(sizeMB * 1024 * 1024);
        const chunkCount = Math.ceil(file.size / ENCRYPTED_CHUNK_SIZE);
        const iters = sizeMB >= 100 ? 3 : sizeMB >= 30 ? 3 : 5;

        console.log(`\n    ${sizeMB}MB → ${chunkCount} encrypted chunks`);

        // Pre-process the file once (this is client-side work)
        const parts = await processFile(file.stream(), file.size, (chunk) =>
          encryptUpdate(key, chunk),
        );
        const storedSize = encryptedStoredSize(file.size);

        await bench(
          `server: store ${chunkCount} chunks (${sizeMB}MB encrypted)`,
          async () => {
            const tempStorage = new InMemoryTemporaryUploadStorage();
            new InMemoryFileStorage({ temporaryUploadStorage: tempStorage });

            await tempStorage.beginUpload("upload", {
              filename: "bench.bin",
              size: storedSize,
              mimeType: "application/octet-stream",
              encrypted: true,
              lastModified: Date.now(),
              documentId: "bench-doc",
            });

            for (const part of parts) {
              await tempStorage.storeChunk(
                "upload",
                part.chunkIndex,
                part.chunkData,
                part.merkleProof,
              );
            }
          },
          { iterations: iters },
        );
      }
    });
  });

  describe("Server-side chunk processing (unstorage)", () => {
    it("encrypted upload - various sizes", async () => {
      const key = await createEncryptionKey();

      for (const sizeMB of [1, 5, 30, 100]) {
        const file = makeFile(sizeMB * 1024 * 1024);
        const chunkCount = Math.ceil(file.size / ENCRYPTED_CHUNK_SIZE);
        const iters = sizeMB >= 100 ? 3 : sizeMB >= 30 ? 3 : 5;

        console.log(`\n    ${sizeMB}MB → ${chunkCount} encrypted chunks (unstorage)`);

        const parts = await processFile(file.stream(), file.size, (chunk) =>
          encryptUpdate(key, chunk),
        );
        const storedSize = encryptedStoredSize(file.size);

        await bench(
          `server unstorage: store ${chunkCount} chunks (${sizeMB}MB encrypted)`,
          async () => {
            const unstorageBackend = createStorage();
            const tempStorage = new UnstorageTemporaryUploadStorage(unstorageBackend, {
              keyPrefix: "file",
            });

            await tempStorage.beginUpload("upload", {
              filename: "bench.bin",
              size: storedSize,
              mimeType: "application/octet-stream",
              encrypted: true,
              lastModified: Date.now(),
              documentId: "bench-doc",
            });

            for (const part of parts) {
              await tempStorage.storeChunk(
                "upload",
                part.chunkIndex,
                part.chunkData,
                part.merkleProof,
              );
            }
          },
          { iterations: iters },
        );
      }
    });
  });

  describe("Full E2E: client processFile + server store + complete", () => {
    it("encrypted upload through server RPC stack", async () => {
      const key = await createEncryptionKey();

      for (const sizeMB of [1, 5, 30, 100]) {
        const file = makeFile(sizeMB * 1024 * 1024);
        const chunkCount = Math.ceil(file.size / ENCRYPTED_CHUNK_SIZE);
        const iters = sizeMB >= 100 ? 3 : sizeMB >= 30 ? 3 : 5;

        console.log(`\n    E2E ${sizeMB}MB → ${chunkCount} chunks (processFile + server RPC)`);

        await bench(
          `e2e encrypted upload (${sizeMB}MB)`,
          async () => {
            const { transport, server, pubSub } = await setupServer();
            await uploadFile(transport, file, key);
            await server[Symbol.asyncDispose]();
            await pubSub[Symbol.asyncDispose]();
          },
          { iterations: iters },
        );
      }
    });

    it("encrypted upload with rate limiting", async () => {
      const key = await createEncryptionKey();
      const sizeMB = 30;
      const file = makeFile(sizeMB * 1024 * 1024);
      const chunkCount = Math.ceil(file.size / ENCRYPTED_CHUNK_SIZE);

      console.log(`\n    E2E ${sizeMB}MB → ${chunkCount} chunks (with rate limiting)`);

      await bench(
        `e2e encrypted upload with rate limit (${sizeMB}MB)`,
        async () => {
          const { transport, server, pubSub } = await setupServer({ withRateLimit: true });
          await uploadFile(transport, file, key);
          await server[Symbol.asyncDispose]();
          await pubSub[Symbol.asyncDispose]();
        },
        { iterations: 3 },
      );
    });
  });

  describe("Breakdown: client vs server time (100MB)", () => {
    it("client: processFile only (encrypt + tree + proofs)", async () => {
      const key = await createEncryptionKey();
      const file = makeFile(100 * 1024 * 1024);
      const chunkCount = Math.ceil(file.size / ENCRYPTED_CHUNK_SIZE);

      console.log(`\n    Client processFile: 100MB → ${chunkCount} chunks`);

      await bench(
        "client: processFile (100MB encrypted)",
        async () => {
          await processFile(file.stream(), file.size, (chunk) => encryptUpdate(key, chunk));
        },
        { iterations: 3 },
      );
    });

    it("server: storeChunk only (in-memory, no RPC overhead)", async () => {
      const key = await createEncryptionKey();
      const file = makeFile(100 * 1024 * 1024);

      const parts = await processFile(file.stream(), file.size, (chunk) =>
        encryptUpdate(key, chunk),
      );
      const storedSize = encryptedStoredSize(file.size);
      const chunkCount = parts.length;

      console.log(`\n    Server storeChunk: ${chunkCount} chunks (100MB)`);

      await bench(
        "server: storeChunk ×" + chunkCount + " (100MB in-memory)",
        async () => {
          const tempStorage = new InMemoryTemporaryUploadStorage();
          await tempStorage.beginUpload("upload", {
            filename: "bench.bin",
            size: storedSize,
            mimeType: "application/octet-stream",
            encrypted: true,
            lastModified: Date.now(),
            documentId: "bench-doc",
          });
          for (const part of parts) {
            await tempStorage.storeChunk(
              "upload",
              part.chunkIndex,
              part.chunkData,
              part.merkleProof,
            );
          }
        },
        { iterations: 3 },
      );

      await bench(
        "server: storeChunk ×" + chunkCount + " (100MB unstorage)",
        async () => {
          const unstorageBackend = createStorage();
          const tempStorage = new UnstorageTemporaryUploadStorage(unstorageBackend, {
            keyPrefix: "file",
          });
          await tempStorage.beginUpload("upload", {
            filename: "bench.bin",
            size: storedSize,
            mimeType: "application/octet-stream",
            encrypted: true,
            lastModified: Date.now(),
            documentId: "bench-doc",
          });
          for (const part of parts) {
            await tempStorage.storeChunk(
              "upload",
              part.chunkIndex,
              part.chunkData,
              part.merkleProof,
            );
          }
        },
        { iterations: 3 },
      );
    });
  });
});
