import { toBase64, fromBase64 } from "teleportal/utils";
import { CHUNK_SIZE, processFileStreaming, verifyMerkleProofAsync } from "teleportal/merkle-tree";
import { AckMessage, type Message } from "teleportal/protocol";
import {
  createDeterministicEncryptor,
  decryptUpdate,
  encryptUpdate,
} from "teleportal/encryption-key";
import { RpcMessage } from "teleportal/protocol";
import type { FilePartStream, FileUploadResponse } from "./methods";
import { emitFileTransferProgress } from "./progress";
import type { ClientRpcHandler } from "../../providers/rpc-handlers";
import type { Provider } from "../../providers/provider";
import type { RpcClient } from "../../providers/rpc-client";
import type { FileCache } from "../../storage/idb/file-cache";

/** Max retransmission rounds per upload before giving up. */
const MAX_RETRANSMIT_ROUNDS = 8;

/**
 * Client-side upper bound on upload size, mirroring the server's limit. Checked
 * before computing chunks so an oversized file fails fast instead of paying a
 * full encrypt+hash pass only to be rejected.
 */
const MAX_FILE_SIZE = 1024 * 1024 * 1024; // 1GB

interface UploadState {
  resolve: (fileId: string) => void;
  reject: (error: Error) => void;
  /** The upload session id, which equals the content-addressed `contentId`. */
  uploadId: string;
  file: File;
  /** The content-addressed id (base64 merkle root); resolved value of the upload. */
  fileId: string;
  /** The full set of encrypted chunks, computed before the request, by index. */
  preparedChunks: Map<number, Uint8Array>;
  /** Maps messageId → chunkIndex for outstanding ACKs. */
  sentChunks: Map<string, number>;
  /** Chunk data kept for retransmission, keyed by chunkIndex. */
  unackedChunks: Map<number, FilePartStream>;
  document: string;
  encryptionKey?: CryptoKey;
  context?: any;
  originalRequestId?: string;
  /** True when all chunks have been sent (file streaming complete) */
  allChunksSent: boolean;
  skipCache?: boolean;
  /** Whether a background retransmit loop is already running. */
  retransmitting: boolean;
  /** Wire chunk size negotiated by the server. */
  chunkSize?: number;
  /** Total chunk count. */
  totalChunks: number;
  /** Distinct chunks acknowledged by the server (incl. server-resumed ones). */
  ackedChunks: number;
  /** The in-flight upload promise, shared when the same content is re-requested. */
  promise: Promise<string>;
}

interface DownloadState {
  resolve: (file: File) => void;
  reject: (error: Error) => void;
  fileMetadata: { filename: string; size: number; mimeType: string; totalChunks?: number } | null;
  chunks: Map<number, Uint8Array>;
  fileId: string;
  document: string;
  timeoutId: ReturnType<typeof setTimeout> | null;
  encryptionKey?: CryptoKey;
  skipCache?: boolean;
}

/**
 * Options for file client handlers.
 */
export interface FileClientHandlerOptions {
  /**
   * Default encryption key to use for file operations.
   * Can be overridden per-operation.
   */
  encryptionKey?: CryptoKey;

  /**
   * Optional persistent file cache (e.g. IndexedDB-backed).
   * When provided, uploaded files are cached optimistically and
   * downloads are served from cache when available.
   */
  cache?: FileCache;
}

class FileClientHandler implements ClientRpcHandler {
  #activeUploads = new Map<string, UploadState>();
  #activeDownloads = new Map<string, DownloadState>();
  #downloadCache = new Map<string, Promise<File>>();
  #rpcClient: RpcClient | null = null;
  #sendStreamMessage: ((message: Message<any>) => Promise<void>) | null = null;
  #encryptionKey?: CryptoKey;
  #cache?: FileCache;
  /** Wire chunk size learned from a prior server response, reused to avoid a
   * renegotiation round-trip on subsequent uploads to the same server. */
  #negotiatedChunkSize?: number;

  constructor(options?: FileClientHandlerOptions) {
    this.#encryptionKey = options?.encryptionKey;
    this.#cache = options?.cache;
  }

  #emitUploadProgress(state: UploadState, status: "active" | "complete" | "error", error?: string) {
    emitFileTransferProgress({
      fileId: state.uploadId,
      document: state.document,
      direction: "upload",
      chunksTransferred: state.ackedChunks,
      totalChunks: state.totalChunks,
      bytesTransferred: Math.min(
        state.file.size,
        state.ackedChunks * (state.chunkSize ?? CHUNK_SIZE),
      ),
      status,
      error,
    });
  }

  #emitDownloadProgress(
    state: DownloadState,
    status: "active" | "complete" | "error",
    error?: string,
  ) {
    const size = state.fileMetadata?.size;
    emitFileTransferProgress({
      fileId: state.fileId,
      document: state.document,
      direction: "download",
      chunksTransferred: state.chunks.size,
      totalChunks: state.fileMetadata?.totalChunks,
      bytesTransferred:
        size !== undefined
          ? Math.min(size, state.chunks.size * CHUNK_SIZE)
          : state.chunks.size * CHUNK_SIZE,
      status,
      error,
    });
  }

  init(_provider: Provider<any>): void {
    // Access private RpcClient through the provider
    // We'll need to expose a way to get it or pass it in
    // For now, we'll store a reference that will be set up by the provider
  }

  /**
   * Set the RPC client and send function for this handler.
   * Called by the Provider during initialization.
   */
  setRpcClient(
    rpcClient: RpcClient,
    sendStreamMessage: (message: Message<any>) => Promise<void>,
  ): void {
    this.#rpcClient = rpcClient;
    this.#sendStreamMessage = sendStreamMessage;
  }

  /**
   * Upload a file.
   *
   * Content-addressed and resumable: the client encrypts the whole file and
   * folds the merkle root (the `contentId`) BEFORE the request, so the server
   * can answer "already have it" (dedup) or "here are the chunks I'm missing"
   * (resume, including across reloads) in a single round-trip. The `_fileId`
   * parameter is accepted for API compatibility but ignored — the returned id is
   * always the content-addressed id.
   */
  async uploadFile(
    file: File,
    document: string,
    _fileId?: string,
    encryptionKey?: CryptoKey,
    skipCache?: boolean,
  ): Promise<string> {
    if (!this.#rpcClient) {
      throw new Error("File handler not initialized: RPC client not set");
    }
    if (!this.#sendStreamMessage) {
      throw new Error("File handler not initialized: stream sender not set");
    }
    if (file.size > MAX_FILE_SIZE) {
      throw new Error(`File size ${file.size} exceeds maximum ${MAX_FILE_SIZE} bytes`);
    }

    const key = encryptionKey ?? this.#encryptionKey;

    // Deterministic encryption makes the merkle root stable across attempts,
    // which is what enables dedup and reload-resume. If the key is
    // non-extractable, fall back to random IVs (each attempt gets a fresh
    // contentId, so dedup/resume won't hit, but the upload still works).
    const encryptChunk = key
      ? ((await createDeterministicEncryptor(key)) ?? ((c: Uint8Array) => encryptUpdate(key, c)))
      : undefined;

    // Try with the assumed chunk size; if the server uses a different one it
    // replies with a mismatch and we recompute once with the server's size.
    let chunkSize = this.#negotiatedChunkSize ?? CHUNK_SIZE;
    for (let attempt = 0; attempt < 2; attempt++) {
      const { preparedChunks, totalChunks, contentId } = await this.#prepareUpload(
        file,
        encryptChunk,
        chunkSize,
      );

      // Collapse concurrent uploads of identical content into one operation.
      const inflight = this.#activeUploads.get(contentId);
      if (inflight) {
        return inflight.promise;
      }

      let resolve!: (id: string) => void;
      let reject!: (err: Error) => void;
      const promise = new Promise<string>((res, rej) => {
        resolve = res;
        reject = rej;
      });

      const state: UploadState = {
        resolve,
        reject,
        uploadId: contentId,
        fileId: contentId,
        file,
        preparedChunks,
        sentChunks: new Map(),
        unackedChunks: new Map(),
        document,
        encryptionKey: key,
        context: { documentId: document },
        originalRequestId: contentId,
        allChunksSent: false,
        skipCache,
        retransmitting: false,
        chunkSize,
        totalChunks,
        ackedChunks: 0,
        promise,
      };
      this.#activeUploads.set(contentId, state);

      let response: FileUploadResponse;
      try {
        response = await this.#rpcClient.sendRequest<FileUploadResponse>(
          document,
          "fileUpload",
          {
            fileId: contentId,
            filename: file.name,
            size: file.size,
            mimeType: file.type || "application/octet-stream",
            lastModified: file.lastModified,
            encrypted: !!key,
            chunkSize,
          },
          { encrypted: !!key, context: { documentId: document } },
        );
      } catch (error) {
        this.#activeUploads.delete(contentId);
        this.#emitUploadProgress(state, "error", (error as Error).message);
        throw error;
      }

      if (!response.allowed) {
        this.#activeUploads.delete(contentId);
        const reason = response.reason || "Upload permission denied";
        this.#emitUploadProgress(state, "error", reason);
        throw new Error(reason);
      }

      if (response.chunkSizeMismatch && response.chunkSize && attempt === 0) {
        // Recompute with the server's chunk size (changes the contentId).
        this.#activeUploads.delete(contentId);
        this.#negotiatedChunkSize = response.chunkSize;
        chunkSize = response.chunkSize;
        continue;
      }

      if (response.chunkSize) {
        this.#negotiatedChunkSize = response.chunkSize;
      }

      // Optimistically cache the content locally (keyed by contentId).
      this.#cacheUploadedFile(state);

      if (response.alreadyExists) {
        this.#activeUploads.delete(contentId);
        this.#emitUploadProgress(state, "complete");
        return contentId;
      }

      this.#streamBufferedChunks(state, response.existingChunks);
      return promise;
    }

    throw new Error("Upload failed: server chunk size renegotiation did not converge");
  }

  /**
   * Encrypt the whole file and fold the merkle root, returning every chunk by
   * index plus the content-addressed id. This is the compute-before-request step
   * that makes uploads resumable and deduplicated.
   */
  async #prepareUpload(
    file: File,
    encryptChunk: ((chunk: Uint8Array) => Promise<Uint8Array> | Uint8Array) | undefined,
    chunkSize: number,
  ): Promise<{ preparedChunks: Map<number, Uint8Array>; totalChunks: number; contentId: string }> {
    const preparedChunks = new Map<number, Uint8Array>();
    const { totalChunks, rootHash } = await processFileStreaming(
      file.stream(),
      file.size,
      encryptChunk,
      (part) => {
        preparedChunks.set(part.chunkIndex, part.chunkData);
      },
      chunkSize,
    );
    return { preparedChunks, totalChunks, contentId: toBase64(rootHash) };
  }

  /**
   * Optimistically persist an uploaded file's chunks + metadata to the local
   * cache (keyed by contentId), before server ACKs arrive.
   */
  #cacheUploadedFile(state: UploadState): void {
    const cache = this.#cache && !state.skipCache ? this.#cache : undefined;
    if (!cache) {
      return;
    }
    const fileId = state.fileId;
    Promise.all([
      ...[...state.preparedChunks].map(([index, data]) => cache.putChunk(fileId, index, data)),
      cache.putMetadata(fileId, {
        filename: state.file.name,
        size: state.file.size,
        mimeType: state.file.type || "application/octet-stream",
        encrypted: !!state.encryptionKey,
        totalChunks: state.totalChunks,
        lastModified: state.file.lastModified,
      }),
    ]).catch(() => {});
  }

  /**
   * Download a file.
   */
  async downloadFile(
    fileId: string,
    document: string,
    encryptionKey?: CryptoKey,
    timeout: number = 60000,
    skipCache?: boolean,
  ): Promise<File> {
    if (!this.#rpcClient) {
      throw new Error("File handler not initialized");
    }

    const key = encryptionKey ?? this.#encryptionKey;

    // Check in-memory dedup cache first
    const cached = this.#downloadCache.get(fileId);
    if (cached) {
      return cached;
    }

    // Check persistent cache (IDB)
    if (this.#cache && !skipCache) {
      const metadata = await this.#cache.getMetadata(fileId);
      if (metadata) {
        const chunks: Uint8Array[] = [];
        let complete = true;
        for (let i = 0; i < metadata.totalChunks; i++) {
          const chunk = await this.#cache.getChunk(fileId, i);
          if (!chunk) {
            complete = false;
            break;
          }
          chunks.push(chunk);
        }
        if (complete) {
          const decryptedParts: Uint8Array[] = [];
          for (const chunk of chunks) {
            decryptedParts.push(key ? await decryptUpdate(key, chunk) : chunk);
          }
          return new File(decryptedParts as BlobPart[], metadata.filename, {
            type: metadata.mimeType,
          });
        }
      }
    }

    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        const handler = this.#activeDownloads.get(fileId);
        if (handler) {
          handler.reject(new Error(`Download timeout after ${timeout}ms`));
          this.#clearDownload(fileId);
          this.#emitDownloadProgress(handler, "error", `Download timeout after ${timeout}ms`);
        }
        reject(new Error(`Download timeout after ${timeout}ms`));
      }, timeout);
    });

    const downloadPromise = new Promise<File>((resolve, reject) => {
      this.#activeDownloads.set(fileId, {
        resolve,
        reject,
        fileMetadata: null,
        chunks: new Map(),
        fileId,
        document,
        timeoutId,
        encryptionKey: key,
        skipCache,
      });
    });

    const promise = Promise.race([downloadPromise, timeoutPromise]);
    this.#downloadCache.set(fileId, promise);

    const requestPayload: Record<string, unknown> = {
      method: "fileDownload",
      fileId,
    };

    try {
      await this.#rpcClient.sendRequest(document, "fileDownload", requestPayload, {
        timeout,
        onStream: (_payload) => {
          // Stream messages are handled via handleStream
          // This is just for tracking
        },
      });
    } catch (error) {
      this.#clearDownload(fileId);
      throw error;
    }

    try {
      return await promise;
    } finally {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
    }
  }

  /**
   * Clear all state for a failed/aborted download. Both the active-download
   * handler and the in-memory dedup entry must be dropped so a subsequent
   * `downloadFile(fileId)` starts fresh instead of returning the stale rejected
   * promise. Never call this on the success path — successful dedup keeps the
   * resolved promise in `#downloadCache` intentionally.
   */
  #clearDownload(fileId: string): void {
    this.#activeDownloads.delete(fileId);
    this.#downloadCache.delete(fileId);
  }

  handleResponse(message: RpcMessage<any>): boolean {
    if (message.requestType !== "response") {
      return false;
    }

    // Upload responses are consumed directly by the awaited sendRequest promise
    // in uploadFile(); only download responses are dispatched here.
    if (message.rpcMethod !== "fileDownload") {
      return false;
    }

    const payload = message.payload as {
      type: "success" | "error";
      payload?: {
        fileId: string;
        filename?: string;
        size?: number;
        mimeType?: string;
        totalChunks?: number;
      };
      details?: string;
    };

    if (payload.type === "success" && payload.payload) {
      const downloadHandler = this.#activeDownloads.get(payload.payload.fileId);
      if (downloadHandler) {
        downloadHandler.fileMetadata = {
          filename: payload.payload.filename!,
          size: payload.payload.size!,
          mimeType: payload.payload.mimeType!,
          totalChunks: payload.payload.totalChunks,
        };
        // Check if download is complete (file parts may have arrived before this response)
        this.#checkDownloadCompletion(downloadHandler);
        return true;
      }
    } else if (payload.type === "error") {
      const downloadHandler = this.#activeDownloads.get(message.originalRequestId!);
      if (downloadHandler) {
        const details = payload.details || "Download permission denied";
        downloadHandler.reject(new Error(details));
        this.#clearDownload(downloadHandler.fileId);
        if (downloadHandler.timeoutId) {
          clearTimeout(downloadHandler.timeoutId);
        }
        this.#emitDownloadProgress(downloadHandler, "error", details);
        return true;
      }
    }

    return false;
  }

  handleStream(message: RpcMessage<any>): boolean {
    if (message.requestType !== "stream") {
      return false;
    }

    if (message.payload.type === "success") {
      const payload = message.payload.payload as FilePartStream;
      this.#handleFilePart(payload, message.context);
      return true;
    }

    return false;
  }

  handleAck(message: Message<any>): boolean {
    if (message.type !== "ack") {
      return false;
    }

    const ackMessage = message as AckMessage<any>;
    let handled = false;

    for (const handler of this.#activeUploads.values()) {
      const chunkIndex = handler.sentChunks.get(ackMessage.payload.messageId);
      if (chunkIndex !== undefined) {
        handler.sentChunks.delete(ackMessage.payload.messageId);
        handled = true;

        if (ackMessage.payload.retryAfter !== undefined) {
          // Nack — server rate-limited this chunk.
          // Kick off the background retransmit loop (idempotent — only one runs at a time).
          this.#startRetransmitLoop(handler, ackMessage.payload.retryAfter);
        } else {
          // Positive ACK — chunk accepted.
          if (handler.unackedChunks.delete(chunkIndex)) {
            handler.ackedChunks++;
          }
          if (handler.allChunksSent && handler.unackedChunks.size === 0) {
            handler.resolve(handler.fileId);
            this.#activeUploads.delete(handler.uploadId);
            this.#emitUploadProgress(handler, "complete");
          } else {
            this.#emitUploadProgress(handler, "active");
          }
        }
      }
    }

    return handled;
  }

  /**
   * Stream the pre-computed chunks the server is missing. The chunks were
   * encrypted and hashed before the request (see {@link uploadFile}); here we
   * just send those the server hasn't already stored, and resolve once every
   * sent chunk is ACKed (see {@link handleAck}).
   */
  #streamBufferedChunks(uploadState: UploadState, existingChunks?: number[]): void {
    if (!this.#sendStreamMessage) {
      uploadState.reject(new Error("File handler not initialized"));
      this.#activeUploads.delete(uploadState.uploadId);
      return;
    }

    const sendStreamMessage = this.#sendStreamMessage;
    const skipChunks = new Set(existingChunks);

    // Server-resumed chunks count as already transferred.
    uploadState.ackedChunks += skipChunks.size;

    for (let chunkIndex = 0; chunkIndex < uploadState.totalChunks; chunkIndex++) {
      if (skipChunks.has(chunkIndex)) {
        continue;
      }
      const chunkData = uploadState.preparedChunks.get(chunkIndex)!;

      const filePart: FilePartStream = {
        fileId: uploadState.uploadId,
        chunkIndex,
        chunkData,
        merkleProof: [],
        totalChunks: uploadState.totalChunks,
        bytesUploaded: 0,
        encrypted: !!uploadState.encryptionKey,
      };

      uploadState.unackedChunks.set(chunkIndex, filePart);

      const message = new RpcMessage<any>(
        uploadState.document,
        { type: "success", payload: filePart },
        "fileUpload",
        "stream",
        uploadState.originalRequestId!,
        uploadState.context,
        filePart.encrypted,
      );
      sendStreamMessage(message).catch(() => {
        // Transport failures are recovered by the retransmit loop
      });
      uploadState.sentChunks.set(message.id, chunkIndex);
    }

    // Mark all chunks as sent - upload can now resolve when all ACKs received
    uploadState.allChunksSent = true;

    // Every chunk's data now lives in `unackedChunks` (the FilePartStream holds
    // the same Uint8Array reference), which shrinks as ACKs arrive and drives
    // retransmission. `preparedChunks` is a second full-file map that is never
    // read again after this point, so release it: peak retained upload memory
    // drops from ~2× file to ~1×, and toward 0 as chunks get ACKed, instead of
    // pinning a whole extra copy until the upload resolves.
    uploadState.preparedChunks.clear();

    // If all ACKs have already been received (or there was nothing to send), resolve now.
    if (uploadState.unackedChunks.size === 0) {
      uploadState.resolve(uploadState.fileId);
      this.#activeUploads.delete(uploadState.uploadId);
      this.#emitUploadProgress(uploadState, "complete");
    } else {
      this.#emitUploadProgress(uploadState, "active");
    }
  }

  /**
   * Start a background loop that retransmits unacked chunks with backoff.
   * Idempotent — if a loop is already running for this upload, this is a no-op.
   * The loop exits when all chunks are ACKed or max rounds are exhausted.
   */
  #startRetransmitLoop(handler: UploadState, retryAfterMs: number) {
    if (handler.retransmitting || !this.#sendStreamMessage) return;
    handler.retransmitting = true;

    const sendStream = this.#sendStreamMessage;
    let delay = Math.max(retryAfterMs, 200);

    const loop = async () => {
      for (let round = 0; round < MAX_RETRANSMIT_ROUNDS; round++) {
        await new Promise((r) => setTimeout(r, delay));

        if (!this.#activeUploads.has(handler.uploadId)) return;
        if (handler.unackedChunks.size === 0) break;

        for (const [chunkIndex, filePart] of handler.unackedChunks) {
          if (!this.#activeUploads.has(handler.uploadId)) return;

          const message = new RpcMessage<any>(
            handler.document,
            { type: "success", payload: filePart },
            "fileUpload",
            "stream",
            handler.originalRequestId ?? handler.uploadId,
            handler.context ?? { documentId: handler.document },
            filePart.encrypted,
          );
          handler.sentChunks.set(message.id, chunkIndex);
          try {
            await sendStream(message);
          } catch {
            break;
          }
        }

        // Wait for ACKs/nacks before next round
        await new Promise((r) => setTimeout(r, delay));

        if (!this.#activeUploads.has(handler.uploadId)) return;
        if (handler.unackedChunks.size === 0) break;

        delay = Math.min(delay * 2, 10_000);
      }

      handler.retransmitting = false;

      if (!this.#activeUploads.has(handler.uploadId)) return;

      if (handler.unackedChunks.size === 0) {
        if (handler.allChunksSent) {
          handler.resolve(handler.fileId);
          this.#activeUploads.delete(handler.uploadId);
          this.#emitUploadProgress(handler, "complete");
        }
      } else {
        const reason = `Upload failed: ${handler.unackedChunks.size} chunks unacknowledged after ${MAX_RETRANSMIT_ROUNDS} retransmission rounds`;
        handler.reject(new Error(reason));
        this.#activeUploads.delete(handler.uploadId);
        this.#emitUploadProgress(handler, "error", reason);
      }
    };

    loop().catch(() => {
      handler.retransmitting = false;
    });
  }

  #verifyChunk(chunk: FilePartStream, fileId: string): Promise<boolean> {
    return verifyMerkleProofAsync(
      chunk.chunkData,
      chunk.merkleProof,
      fromBase64(fileId),
      chunk.chunkIndex,
      chunk.totalChunks,
    );
  }

  async #handleFilePart(payload: FilePartStream, _context?: any) {
    const handler = this.#activeDownloads.get(payload.fileId);
    if (!handler) {
      return;
    }

    if (handler.chunks.has(payload.chunkIndex)) return;

    // Verify and decrypt concurrently — both run in native Web Crypto, so a
    // 1MB chunk costs ~1ms of main-thread time instead of ~50ms of synchronous
    // pure-JS SHA-256 that would serialize part processing and jank the UI.
    const [isValid, decrypted] = await Promise.all([
      this.#verifyChunk(payload, handler.fileId),
      handler.encryptionKey
        ? decryptUpdate(handler.encryptionKey, payload.chunkData)
        : payload.chunkData,
    ]);

    // Re-check after the await: a concurrently-verifying part may have failed
    // the download (handler removed) or already delivered this chunk index.
    if (!this.#activeDownloads.has(payload.fileId)) return;
    if (handler.chunks.has(payload.chunkIndex)) return;

    if (!isValid) {
      const reason = `Chunk ${payload.chunkIndex} failed merkle proof verification`;
      handler.reject(new Error(reason));
      this.#clearDownload(payload.fileId);
      if (handler.timeoutId) {
        clearTimeout(handler.timeoutId);
      }
      this.#emitDownloadProgress(handler, "error", reason);
      return;
    }

    // Cache the verified ciphertext chunk (before decryption)
    if (this.#cache && !handler.skipCache) {
      this.#cache.putChunk(payload.fileId, payload.chunkIndex, payload.chunkData).catch(() => {});
    }

    handler.chunks.set(payload.chunkIndex, decrypted);
    if (handler.fileMetadata && handler.fileMetadata.totalChunks === undefined) {
      handler.fileMetadata.totalChunks = payload.totalChunks;
    }
    this.#emitDownloadProgress(handler, "active");
    this.#checkDownloadCompletion(handler);
  }

  #checkDownloadCompletion(handler: DownloadState) {
    if (!handler.fileMetadata) {
      return;
    }
    const expectedChunks =
      handler.fileMetadata.totalChunks ??
      (handler.fileMetadata.size === 0 ? 1 : Math.ceil(handler.fileMetadata.size / CHUNK_SIZE));
    if (handler.chunks.size >= expectedChunks) {
      try {
        const parts: Uint8Array[] = [];
        for (let i = 0; i < expectedChunks; i++) {
          const chunk = handler.chunks.get(i);
          if (!chunk) {
            throw new Error(`Missing chunk ${i}`);
          }
          parts.push(chunk);
        }
        const file = new File(parts as BlobPart[], handler.fileMetadata.filename, {
          type: handler.fileMetadata.mimeType,
        });

        // Write metadata to persistent cache (chunks were written in #handleFilePart)
        if (this.#cache && !handler.skipCache) {
          this.#cache
            .putMetadata(handler.fileId, {
              filename: handler.fileMetadata.filename,
              size: handler.fileMetadata.size,
              mimeType: handler.fileMetadata.mimeType,
              encrypted: !!handler.encryptionKey,
              totalChunks: expectedChunks,
              lastModified: file.lastModified,
            })
            .catch(() => {});
        }

        handler.resolve(file);
        this.#emitDownloadProgress(handler, "complete");
      } catch (err) {
        handler.reject(err as Error);
        // Drop the poisoned dedup entry so a retry starts fresh. The success
        // path deliberately leaves #downloadCache populated for dedup.
        this.#downloadCache.delete(handler.fileId);
        this.#emitDownloadProgress(handler, "error", (err as Error).message);
      } finally {
        this.#activeDownloads.delete(handler.fileId);
        if (handler.timeoutId) {
          clearTimeout(handler.timeoutId);
        }
      }
    }
  }

  /**
   * Get active uploads (for debugging/monitoring).
   */
  get activeUploads(): Map<string, UploadState> {
    return this.#activeUploads;
  }

  /**
   * Get active downloads (for debugging/monitoring).
   */
  get activeDownloads(): Map<string, DownloadState> {
    return this.#activeDownloads;
  }
}

/**
 * Create client RPC handlers for file upload/download operations.
 *
 * @param options - Optional configuration for the file handlers
 * @returns A registry of file RPC handlers
 *
 * @example
 * ```typescript
 * import { getFileClientHandlers } from "teleportal/protocols/file";
 * import { createEncryptionKey } from "teleportal/encryption-key";
 *
 * // Content encryption is the default, so an encryptionKey is required.
 * const myKey = await createEncryptionKey();
 *
 * const provider = await Provider.create({
 *   url: "wss://...",
 *   document: "my-doc",
 *   encryptionKey: myKey,
 *   rpcHandlers: {
 *     ...getFileClientHandlers({ encryptionKey: myKey }),
 *   },
 * });
 * ```
 */
export function getFileClientHandlers(options?: FileClientHandlerOptions): {
  fileUpload: ClientRpcHandler;
  fileDownload: ClientRpcHandler;
} {
  const handler = new FileClientHandler(options);

  return {
    fileUpload: handler,
    fileDownload: handler,
  };
}

// Export the handler instance type for Provider to access uploadFile/downloadFile
export type FileClientHandlerInstance = FileClientHandler;
