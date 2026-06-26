import { describe, expect, it, beforeEach } from "bun:test";
import { toBase64 } from "lib0/buffer";
import { AckMessage, type Message } from "teleportal";
import { RpcMessage } from "teleportal/protocol";
import { buildMerkleTree, CHUNK_SIZE, generateMerkleProof } from "teleportal/merkle-tree";
import type { CachedFileMetadata, FileCache } from "../../storage/idb/file-cache";
import { getFileClientHandlers } from "./transfer";

// ---------------------------------------------------------------------------
// In-memory FileCache for testing
// ---------------------------------------------------------------------------

class InMemoryFileCache implements FileCache {
  metadata = new Map<string, CachedFileMetadata>();
  chunks = new Map<string, Uint8Array>();

  async getMetadata(fileId: string) {
    return this.metadata.get(fileId) ?? null;
  }
  async getChunk(fileId: string, chunkIndex: number) {
    return this.chunks.get(`${fileId}:${chunkIndex}`) ?? null;
  }
  async putMetadata(fileId: string, meta: CachedFileMetadata) {
    this.metadata.set(fileId, meta);
  }
  async putChunk(fileId: string, chunkIndex: number, data: Uint8Array) {
    this.chunks.set(`${fileId}:${chunkIndex}`, data);
  }
  async delete(fileId: string) {
    const meta = this.metadata.get(fileId);
    if (meta) {
      for (let i = 0; i < meta.totalChunks; i++) {
        this.chunks.delete(`${fileId}:${i}`);
      }
      this.metadata.delete(fileId);
    }
  }
  async has(fileId: string) {
    return this.metadata.has(fileId);
  }
  async clear() {
    this.metadata.clear();
    this.chunks.clear();
  }
  close() {}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFileData(size: number, fill: number = 0xab): Uint8Array {
  const data = new Uint8Array(size);
  data.fill(fill);
  return data;
}

function makeContentAddressedFile(data: Uint8Array) {
  const totalChunks = data.length === 0 ? 1 : Math.ceil(data.length / CHUNK_SIZE);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, data.length);
    chunks.push(data.slice(start, end));
  }
  if (chunks.length === 0) chunks.push(new Uint8Array(0));

  const tree = buildMerkleTree(chunks);
  const root = tree.nodes.at(-1)!.hash!;
  const fileId = toBase64(root);

  return { fileId, chunks, tree, root, totalChunks };
}

/**
 * Simulate a full upload through the FileClientHandler:
 * 1. Call uploadFile()
 * 2. Feed the handleResponse (upload accepted)
 * 3. Capture the stream messages, ACK them all
 */
async function simulateUpload(
  handler: any,
  file: File,
  document: string,
  encryptionKey?: CryptoKey,
) {
  const sentMessages: RpcMessage<any>[] = [];

  handler.setRpcClient(
    {
      sendRequest: async (_doc: string, _method: string, _payload: any, _opts: any) => {
        // no-op — the response is fed via handleResponse
      },
      sendStream: async (msg: RpcMessage<any>) => {
        sentMessages.push(msg);
      },
    },
    async (msg: Message<any>) => {
      sentMessages.push(msg as RpcMessage<any>);
    },
  );

  const uploadPromise = handler.uploadFile(file, document, undefined, encryptionKey);

  // Wait a tick for the request to be sent
  await new Promise((r) => setTimeout(r, 0));

  // Find the uploadId from the active uploads
  const uploadId = [...handler.activeUploads.keys()][0];

  // Simulate server accepting the upload
  handler.handleResponse(
    new RpcMessage<any>(
      document,
      { type: "success", payload: { fileId: uploadId } },
      "fileUpload",
      "response",
      uploadId,
    ),
  );

  // Wait for all chunks to be sent
  await new Promise((r) => setTimeout(r, 0));
  // May need more ticks for async generators
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }

  // ACK all sent stream messages
  for (const msg of sentMessages) {
    if (msg.requestType === "stream") {
      handler.handleAck(new AckMessage({ type: "ack", messageId: msg.id }));
    }
  }

  const fileId = await uploadPromise;
  return { fileId, sentMessages };
}

/**
 * Simulate a download: feed the handler response + stream parts for a known file.
 */
async function simulateDownload(
  handler: any,
  fileId: string,
  fileData: { chunks: Uint8Array[]; tree: ReturnType<typeof buildMerkleTree> },
  metadata: { filename: string; size: number; mimeType: string },
  document: string,
  skipCache?: boolean,
) {
  handler.setRpcClient(
    {
      sendRequest: async (_doc: string, _method: string, _payload: any, _opts: any) => {
        // no-op
      },
      sendStream: async () => {},
    },
    async () => {},
  );

  const downloadPromise = handler.downloadFile(fileId, document, undefined, undefined, skipCache);

  await new Promise((r) => setTimeout(r, 0));

  // Send download response with metadata
  handler.handleResponse(
    new RpcMessage<any>(
      document,
      {
        type: "success",
        payload: {
          fileId,
          filename: metadata.filename,
          size: metadata.size,
          mimeType: metadata.mimeType,
        },
      },
      "fileDownload",
      "response",
      fileId,
    ),
  );

  // Send file chunks as stream messages
  for (let i = 0; i < fileData.chunks.length; i++) {
    const proof = generateMerkleProof(fileData.tree, i);
    let bytesSoFar = 0;
    for (let j = 0; j <= i; j++) bytesSoFar += fileData.chunks[j].length;

    handler.handleStream(
      new RpcMessage<any>(
        document,
        {
          type: "success",
          payload: {
            fileId,
            chunkIndex: i,
            chunkData: fileData.chunks[i],
            merkleProof: proof,
            totalChunks: fileData.chunks.length,
            bytesUploaded: bytesSoFar,
            encrypted: false,
          },
        },
        "fileDownload",
        "stream",
        fileId,
      ),
    );
  }

  return downloadPromise;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FileClientHandler cache integration", () => {
  let cache: InMemoryFileCache;

  beforeEach(() => {
    cache = new InMemoryFileCache();
  });

  it("upload populates the cache with encrypted chunks", async () => {
    const handlers = getFileClientHandlers({ cache });
    const handler = handlers.fileUpload as any;

    const data = makeFileData(100);
    const file = new File([data] as BlobPart[], "test.bin", { type: "application/octet-stream" });

    const { fileId } = await simulateUpload(handler, file, "doc-1");

    // Cache should have metadata + chunks
    expect(await cache.has(fileId)).toBe(true);
    const meta = await cache.getMetadata(fileId);
    expect(meta).not.toBeNull();
    expect(meta!.filename).toBe("test.bin");
    expect(meta!.totalChunks).toBe(1);
    expect(meta!.mimeType).toBe("application/octet-stream");

    const chunk = await cache.getChunk(fileId, 0);
    expect(chunk).not.toBeNull();
    expect(chunk!.length).toBe(100);
  });

  it("download serves from cache without server round-trip", async () => {
    const handlers = getFileClientHandlers({ cache });
    const handler = handlers.fileUpload as any;

    // Pre-populate cache with a known file
    const data = makeFileData(50, 0xcd);
    const { fileId, chunks } = makeContentAddressedFile(data);

    await cache.putMetadata(fileId, {
      filename: "cached.bin",
      size: 50,
      mimeType: "application/octet-stream",
      encrypted: false,
      totalChunks: 1,
      lastModified: Date.now(),
    });
    await cache.putChunk(fileId, 0, chunks[0]);

    // Set up handler with a mock RPC client that will reject if called
    let serverCalled = false;
    handler.setRpcClient(
      {
        sendRequest: async () => {
          serverCalled = true;
          throw new Error("Should not call server when cache hit");
        },
        sendStream: async () => {},
      },
      async () => {},
    );

    const file = await handler.downloadFile(fileId, "doc-1");

    expect(serverCalled).toBe(false);
    expect(file.name).toBe("cached.bin");
    expect(file.size).toBe(50);

    // Verify the content matches
    const buf = new Uint8Array(await file.arrayBuffer());
    expect(buf.every((b) => b === 0xcd)).toBe(true);
  });

  it("download from server populates the cache", async () => {
    const handlers = getFileClientHandlers({ cache });
    const handler = handlers.fileUpload as any;

    const data = makeFileData(200, 0xef);
    const { fileId, chunks, tree } = makeContentAddressedFile(data);

    const file = await simulateDownload(
      handler,
      fileId,
      { chunks, tree },
      { filename: "from-server.bin", size: 200, mimeType: "application/octet-stream" },
      "doc-1",
    );

    expect(file.name).toBe("from-server.bin");
    expect(file.size).toBe(200);

    // Wait for fire-and-forget cache writes
    await new Promise((r) => setTimeout(r, 1));

    // Cache should now be populated
    expect(await cache.has(fileId)).toBe(true);
    const meta = await cache.getMetadata(fileId);
    expect(meta!.filename).toBe("from-server.bin");
    expect(meta!.totalChunks).toBe(1);

    const cachedChunk = await cache.getChunk(fileId, 0);
    expect(cachedChunk).not.toBeNull();
    expect(cachedChunk!.length).toBe(200);
  });

  it("multi-chunk file round-trips through cache", async () => {
    const handlers = getFileClientHandlers({ cache });
    const handler = handlers.fileUpload as any;

    // Create a file larger than CHUNK_SIZE to get multiple chunks
    const data = makeFileData(CHUNK_SIZE + 100, 0x42);
    const file = new File([data] as BlobPart[], "big.bin", { type: "application/octet-stream" });

    const { fileId } = await simulateUpload(handler, file, "doc-1");

    // Verify cache has 2 chunks
    const meta = await cache.getMetadata(fileId);
    expect(meta!.totalChunks).toBe(2);
    expect(await cache.getChunk(fileId, 0)).not.toBeNull();
    expect(await cache.getChunk(fileId, 1)).not.toBeNull();

    // Now download from cache (fresh handler with same cache)
    const handlers2 = getFileClientHandlers({ cache });
    const handler2 = handlers2.fileUpload as any;

    let serverCalled = false;
    handler2.setRpcClient(
      {
        sendRequest: async () => {
          serverCalled = true;
          throw new Error("Should not call server");
        },
        sendStream: async () => {},
      },
      async () => {},
    );

    const downloaded = await handler2.downloadFile(fileId, "doc-1");
    expect(serverCalled).toBe(false);
    expect(downloaded.name).toBe("big.bin");
    expect(downloaded.size).toBe(CHUNK_SIZE + 100);

    const buf = new Uint8Array(await downloaded.arrayBuffer());
    expect(buf.every((b) => b === 0x42)).toBe(true);
  });

  it("skipCache=true bypasses cache on download", async () => {
    const handlers = getFileClientHandlers({ cache });
    const handler = handlers.fileUpload as any;

    // Pre-populate cache
    const data = makeFileData(50);
    const { fileId, chunks } = makeContentAddressedFile(data);
    await cache.putMetadata(fileId, {
      filename: "cached.bin",
      size: 50,
      mimeType: "application/octet-stream",
      encrypted: false,
      totalChunks: 1,
      lastModified: Date.now(),
    });
    await cache.putChunk(fileId, 0, chunks[0]);

    // Download with skipCache=true — should hit the server (which we simulate)
    const { tree } = makeContentAddressedFile(data);
    const file = await simulateDownload(
      handler,
      fileId,
      { chunks, tree },
      { filename: "from-server.bin", size: 50, mimeType: "application/octet-stream" },
      "doc-1",
      true,
    );

    // Gets the server version, not the cached version
    expect(file.name).toBe("from-server.bin");
  });

  it("incomplete cache falls through to server", async () => {
    const handlers = getFileClientHandlers({ cache });
    const handler = handlers.fileUpload as any;

    // Put metadata but no chunks — simulates an incomplete cache entry
    const data = makeFileData(50, 0xbb);
    const { fileId, chunks, tree } = makeContentAddressedFile(data);
    await cache.putMetadata(fileId, {
      filename: "incomplete.bin",
      size: 50,
      mimeType: "application/octet-stream",
      encrypted: false,
      totalChunks: 1,
      lastModified: Date.now(),
    });
    // No chunks stored — cache miss

    const file = await simulateDownload(
      handler,
      fileId,
      { chunks, tree },
      { filename: "server-fallback.bin", size: 50, mimeType: "application/octet-stream" },
      "doc-1",
    );

    expect(file.name).toBe("server-fallback.bin");
    expect(file.size).toBe(50);
  });

  it("no cache configured: upload and download work normally", async () => {
    const handlers = getFileClientHandlers({}); // no cache
    const handler = handlers.fileUpload as any;

    const data = makeFileData(100);
    const file = new File([data] as BlobPart[], "no-cache.bin", {
      type: "application/octet-stream",
    });

    const { fileId } = await simulateUpload(handler, file, "doc-1");
    expect(fileId).toBeTruthy();

    // Cache is empty (none configured)
    expect(cache.metadata.size).toBe(0);
    expect(cache.chunks.size).toBe(0);
  });

  it("30MB upload with rate-limit nacks retransmits and completes", async () => {
    const FILE_SIZE = 30 * 1024 * 1024; // 30 MB
    const EXPECTED_CHUNKS = Math.ceil(FILE_SIZE / CHUNK_SIZE); // 480

    const handlers = getFileClientHandlers({ cache });
    const handler = handlers.fileUpload as any;

    // Token-bucket rate limiter: ACK the first `bucketSize` chunks per burst,
    // nack the rest with retryAfter. Refill the bucket each retransmission round.
    const BUCKET_SIZE = 200;
    let tokensRemaining = BUCKET_SIZE;
    const ackedChunks = new Set<number>();
    let nackedCount = 0;
    let retransmitCount = 0;

    handler.setRpcClient(
      {
        sendRequest: async () => {},
        sendStream: async () => {},
      },
      async (msg: Message<any>) => {
        if (!(msg instanceof RpcMessage) || msg.requestType !== "stream") return;

        const payload = msg.payload?.payload as Record<string, unknown> | undefined;
        if (!payload || payload.chunkIndex === undefined) return;

        const chunkIndex = payload.chunkIndex as number;

        // Already ACKed (retransmission of a chunk we already accepted)
        if (ackedChunks.has(chunkIndex)) {
          queueMicrotask(() => {
            handler.handleAck(new AckMessage({ type: "ack", messageId: msg.id }));
          });
          return;
        }

        if (tokensRemaining > 0) {
          tokensRemaining--;
          ackedChunks.add(chunkIndex);
          queueMicrotask(() => {
            handler.handleAck(new AckMessage({ type: "ack", messageId: msg.id }));
          });
        } else {
          nackedCount++;
          queueMicrotask(() => {
            handler.handleAck(new AckMessage({ type: "ack", messageId: msg.id, retryAfter: 1 }));
          });
        }
      },
    );

    const data = new Uint8Array(FILE_SIZE);
    const file = new File([data] as BlobPart[], "large.bin", {
      type: "application/octet-stream",
    });

    const uploadPromise = handler.uploadFile(file, "doc-1");

    await new Promise((r) => setTimeout(r, 0));

    const uploadId = [...handler.activeUploads.keys()][0];
    handler.handleResponse(
      new RpcMessage<any>(
        "doc-1",
        { type: "success", payload: { fileId: uploadId } },
        "fileUpload",
        "response",
        uploadId,
      ),
    );

    // Refill the bucket whenever the retransmit loop fires so it
    // eventually accepts all remaining chunks.
    const refillInterval = setInterval(() => {
      if (tokensRemaining === 0) {
        tokensRemaining = BUCKET_SIZE;
        retransmitCount++;
      }
    }, 5);

    const fileId = await uploadPromise;
    clearInterval(refillInterval);

    expect(fileId).toBeTruthy();
    expect(ackedChunks.size).toBe(EXPECTED_CHUNKS);
    expect(nackedCount).toBeGreaterThan(0);
    expect(retransmitCount).toBeGreaterThan(0);

    // Verify cache was populated
    const meta = await cache.getMetadata(fileId);
    expect(meta).not.toBeNull();
    expect(meta!.totalChunks).toBe(EXPECTED_CHUNKS);
    expect(meta!.filename).toBe("large.bin");
  }, 30_000);
});
