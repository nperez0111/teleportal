import { describe, expect, it, beforeEach } from "bun:test";
import { toBase64 } from "teleportal/utils";
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

async function makeContentAddressedFile(data: Uint8Array) {
  const totalChunks = data.length === 0 ? 1 : Math.ceil(data.length / CHUNK_SIZE);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, data.length);
    chunks.push(data.slice(start, end));
  }
  if (chunks.length === 0) chunks.push(new Uint8Array(0));

  const tree = await buildMerkleTree(chunks);
  const root = tree.nodes.at(-1)!.hash!;
  const fileId = toBase64(root);

  return { fileId, chunks, tree, root, totalChunks };
}

/**
 * Simulate a full upload through the FileClientHandler:
 * 1. Call uploadFile() — it computes chunks, then awaits the upload response.
 * 2. The mocked sendRequest accepts the upload (echoing the content-addressed id).
 * 3. Capture the streamed chunks and ACK them all.
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
      sendRequest: async (_doc: string, _method: string, payload: any) => {
        // Accept the upload; echo back the client-computed content-addressed id.
        return { fileId: payload.fileId, allowed: true, chunkSize: CHUNK_SIZE };
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

  // Let prepare + request + stream run.
  for (let i = 0; i < 12; i++) {
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
  fileData: { chunks: Uint8Array[]; tree: Awaited<ReturnType<typeof buildMerkleTree>> },
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
    const { fileId, chunks } = await makeContentAddressedFile(data);

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
    const { fileId, chunks, tree } = await makeContentAddressedFile(data);

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
    const { fileId, chunks } = await makeContentAddressedFile(data);
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
    const { tree } = await makeContentAddressedFile(data);
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
    const { fileId, chunks, tree } = await makeContentAddressedFile(data);
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

  it("dedup: alreadyExists resolves immediately with zero chunks streamed", async () => {
    const handlers = getFileClientHandlers({ cache });
    const handler = handlers.fileUpload as any;

    let streamCount = 0;
    handler.setRpcClient(
      {
        sendRequest: async (_doc: string, _method: string, payload: any) => {
          // Server reports the content already exists.
          return {
            fileId: payload.fileId,
            allowed: true,
            alreadyExists: true,
            chunkSize: CHUNK_SIZE,
          };
        },
        sendStream: async () => {
          streamCount++;
        },
      },
      async () => {
        streamCount++;
      },
    );

    const data = makeFileData(CHUNK_SIZE + 100, 0x55);
    const file = new File([data] as BlobPart[], "dup.bin", { type: "application/octet-stream" });

    const fileId = await handler.uploadFile(file, "doc-1");
    expect(fileId).toBeTruthy();
    expect(streamCount).toBe(0);
  });

  it("resume: only chunks not in existingChunks are streamed", async () => {
    const handlers = getFileClientHandlers({ cache });
    const handler = handlers.fileUpload as any;

    const streamed: number[] = [];
    handler.setRpcClient(
      {
        sendRequest: async (_doc: string, _method: string, payload: any) => {
          // Server already has chunk 0 from a prior attempt.
          return {
            fileId: payload.fileId,
            allowed: true,
            existingChunks: [0],
            chunkSize: CHUNK_SIZE,
          };
        },
        sendStream: async () => {},
      },
      async (msg: Message<any>) => {
        streamed.push(((msg as RpcMessage<any>).payload.payload as any).chunkIndex);
      },
    );

    // 3-chunk file; chunk 0 is resumed, so only 1 and 2 should stream.
    const data = makeFileData(2 * CHUNK_SIZE + 100, 0x66);
    const file = new File([data] as BlobPart[], "resume.bin", { type: "application/octet-stream" });

    const uploadPromise = handler.uploadFile(file, "doc-1");
    for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));

    for (const key of handler.activeUploads.keys()) {
      const state = handler.activeUploads.get(key);
      for (const [msgId] of state.sentChunks) {
        handler.handleAck(new AckMessage({ type: "ack", messageId: msgId }));
      }
    }
    await uploadPromise;

    expect(streamed.sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it("multi-chunk upload with rate-limit nacks retransmits and completes", async () => {
    const FILE_SIZE = 2 * 1024 * 1024; // 2 MB
    const EXPECTED_CHUNKS = Math.ceil(FILE_SIZE / CHUNK_SIZE); // 32

    const handlers = getFileClientHandlers({ cache });
    const handler = handlers.fileUpload as any;

    // Token-bucket rate limiter: ACK the first `bucketSize` chunks per burst,
    // nack the rest with retryAfter. Refill the bucket each retransmission round.
    const BUCKET_SIZE = Math.max(1, Math.floor(EXPECTED_CHUNKS / 3));
    let tokensRemaining = BUCKET_SIZE;
    const ackedChunks = new Set<number>();
    let nackedCount = 0;
    let retransmitCount = 0;

    handler.setRpcClient(
      {
        sendRequest: async (_doc: string, _method: string, payload: any) => {
          return { fileId: payload.fileId, allowed: true, chunkSize: CHUNK_SIZE };
        },
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

    // Refill the bucket whenever the retransmit loop fires so it
    // eventually accepts all remaining chunks.
    const refillInterval = setInterval(() => {
      if (tokensRemaining === 0) {
        tokensRemaining = BUCKET_SIZE;
        retransmitCount++;
      }
    }, 1);

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
  });

  it("a failed download does not poison the dedup cache (retry can succeed)", async () => {
    // No cache: force the server path so the in-memory #downloadCache is used.
    const handlers = getFileClientHandlers({});
    const handler = handlers.fileUpload as any;

    const data = makeFileData(80, 0x77);
    const { fileId, chunks, tree } = await makeContentAddressedFile(data);
    const metadata = { filename: "retry.bin", size: 80, mimeType: "application/octet-stream" };
    const document = "doc-1";

    handler.setRpcClient(
      {
        // Resolve immediately; delivery happens via handleResponse/handleStream below.
        sendRequest: async () => {},
        sendStream: async () => {},
      },
      async () => {},
    );

    // --- First attempt: deliver a corrupted chunk so merkle verification fails. ---
    const firstPromise = handler.downloadFile(fileId, document);
    await new Promise((r) => setTimeout(r, 0));

    handler.handleResponse(
      new RpcMessage<any>(
        document,
        { type: "success", payload: { fileId, ...metadata } },
        "fileDownload",
        "response",
        fileId,
      ),
    );

    // Corrupt the chunk data so it won't match the (valid) merkle proof.
    const proof = generateMerkleProof(tree, 0);
    const corrupted = chunks[0].slice();
    corrupted[0] ^= 0xff;
    handler.handleStream(
      new RpcMessage<any>(
        document,
        {
          type: "success",
          payload: {
            fileId,
            chunkIndex: 0,
            chunkData: corrupted,
            merkleProof: proof,
            totalChunks: chunks.length,
            bytesUploaded: chunks[0].length,
            encrypted: false,
          },
        },
        "fileDownload",
        "stream",
        fileId,
      ),
    );

    await expect(firstPromise).rejects.toThrow(/merkle proof verification/i);

    // --- Second attempt: the same fileId must NOT be short-circuited to the
    // stale rejected promise. A clean retry (valid chunk) should succeed. ---
    const secondPromise = simulateDownload(handler, fileId, { chunks, tree }, metadata, document);

    const file = await secondPromise;
    expect(file.name).toBe("retry.bin");
    expect(file.size).toBe(80);
    const buf = new Uint8Array(await file.arrayBuffer());
    expect(buf.every((b) => b === 0x77)).toBe(true);
  });
});
