import { toBase64, fromBase64 } from "lib0/buffer";
import { uuidv4 } from "lib0/random";
import {
  CHUNK_SIZE,
  processFile,
  ENCRYPTED_CHUNK_SIZE,
  verifyMerkleProof,
} from "teleportal/merkle-tree";
import { AckMessage, type Message } from "teleportal/protocol";
import { decryptUpdate, encryptUpdate } from "teleportal/encryption-key";
import { RpcMessage } from "teleportal/protocol";
import type { FilePartStream } from "./methods";
import type { ClientRpcHandler } from "../../providers/rpc-handlers";
import type { Provider } from "../../providers/provider";
import type { RpcClient } from "../../providers/rpc-client";
import type { FileCache } from "../../storage/idb/file-cache";

/** Max retransmission rounds per upload before giving up. */
const MAX_RETRANSMIT_ROUNDS = 8;

interface UploadState {
  resolve: (fileId: string) => void;
  reject: (error: Error) => void;
  uploadId: string;
  file: File;
  fileId: string | null;
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
}

interface DownloadState {
  resolve: (file: File) => void;
  reject: (error: Error) => void;
  fileMetadata: { filename: string; size: number; mimeType: string } | null;
  chunks: Map<number, Uint8Array>;
  fileId: string;
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

  constructor(options?: FileClientHandlerOptions) {
    this.#encryptionKey = options?.encryptionKey;
    this.#cache = options?.cache;
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
   */
  async uploadFile(
    file: File,
    document: string,
    fileId: string = uuidv4(),
    encryptionKey?: CryptoKey,
    skipCache?: boolean,
  ): Promise<string> {
    if (!this.#rpcClient) {
      throw new Error("File handler not initialized: RPC client not set");
    }
    if (!this.#sendStreamMessage) {
      throw new Error("File handler not initialized: stream sender not set");
    }

    const key = encryptionKey ?? this.#encryptionKey;

    const uploadPromise = new Promise<string>((resolve, reject) => {
      this.#activeUploads.set(fileId, {
        resolve,
        reject,
        uploadId: fileId,
        fileId: null,
        file,
        sentChunks: new Map(),
        unackedChunks: new Map(),
        document,
        encryptionKey: key,
        allChunksSent: false,
        skipCache,
        retransmitting: false,
      });
    });

    let encryptionOverhead = 0;
    if (key) {
      const numberOfChunks = file.size === 0 ? 1 : Math.ceil(file.size / ENCRYPTED_CHUNK_SIZE);
      encryptionOverhead = numberOfChunks * (CHUNK_SIZE - ENCRYPTED_CHUNK_SIZE);
    }

    const requestPayload: Record<string, unknown> = {
      fileId,
      filename: file.name,
      size: file.size + encryptionOverhead,
      mimeType: file.type || "application/octet-stream",
      lastModified: file.lastModified,
      encrypted: !!key,
    };

    // Send the upload request - the response will trigger file upload via handleResponse
    // We don't await this - the promise will resolve when upload completes
    this.#rpcClient
      .sendRequest(document, "fileUpload", requestPayload, {
        encrypted: !!key,
        context: { documentId: document },
      })
      .catch((error) => {
        const uploadState = this.#activeUploads.get(fileId);
        if (uploadState) {
          uploadState.reject(error as Error);
          this.#activeUploads.delete(fileId);
        }
      });

    return uploadPromise;
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
          this.#activeDownloads.delete(fileId);
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
      this.#activeDownloads.delete(fileId);
      this.#downloadCache.delete(fileId);
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

  handleResponse(message: RpcMessage<any>): boolean {
    if (message.requestType !== "response") {
      return false;
    }

    const payload = message.payload as {
      type: "success" | "error";
      payload?: {
        fileId: string;
        filename?: string;
        size?: number;
        mimeType?: string;
        existingChunks?: number[];
      };
      details?: string;
    };

    if (payload.type === "success" && payload.payload) {
      // Check if this is a download response (has metadata)
      if (payload.payload.filename !== undefined) {
        const downloadHandler = this.#activeDownloads.get(payload.payload.fileId);
        if (downloadHandler) {
          downloadHandler.fileMetadata = {
            filename: payload.payload.filename!,
            size: payload.payload.size!,
            mimeType: payload.payload.mimeType!,
          };
          // Check if download is complete (file parts may have arrived before this response)
          this.#checkDownloadCompletion(downloadHandler);
          return true;
        }
      }

      // Check if this is an upload response (just has fileId)
      const uploadHandler = this.#activeUploads.get(payload.payload.fileId);
      if (uploadHandler) {
        // Start processing the file upload
        // We don't await this - it runs in the background and the upload promise
        // resolves when all ACKs are received. Errors are caught and the upload is rejected.
        this.#processFileUpload(
          uploadHandler,
          message.context,
          undefined,
          payload.payload.existingChunks,
        ).catch((error) => {
          uploadHandler.reject(error);
          this.#activeUploads.delete(uploadHandler.uploadId);
        });
        return true;
      }
    } else if (payload.type === "error") {
      // Handle error responses - check by original request ID first
      const uploadHandler = this.#activeUploads.get(message.originalRequestId!);
      if (uploadHandler) {
        uploadHandler.reject(new Error(payload.details || "Upload permission denied"));
        this.#activeUploads.delete(uploadHandler.uploadId);
        return true;
      }

      const downloadHandler = this.#activeDownloads.get(message.originalRequestId!);
      if (downloadHandler) {
        downloadHandler.reject(new Error(payload.details || "Download permission denied"));
        this.#activeDownloads.delete(downloadHandler.fileId);
        if (downloadHandler.timeoutId) {
          clearTimeout(downloadHandler.timeoutId);
        }
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
          handler.unackedChunks.delete(chunkIndex);
          if (handler.allChunksSent && handler.unackedChunks.size === 0) {
            handler.resolve(handler.fileId!);
            this.#activeUploads.delete(handler.uploadId);
          }
        }
      }
    }

    return handled;
  }

  async #processFileUpload(
    uploadState: UploadState,
    context?: any,
    originalRequestId?: string,
    existingChunks?: number[],
  ) {
    if (!this.#sendStreamMessage) {
      throw new Error("File handler not initialized");
    }

    const skipChunks = new Set(existingChunks);
    const cache = this.#cache && !uploadState.skipCache ? this.#cache : undefined;
    const cachedChunks: { index: number; data: Uint8Array }[] = [];

    const parts = await processFile(
      uploadState.file.stream(),
      uploadState.file.size,
      uploadState.encryptionKey
        ? (chunk: Uint8Array) => encryptUpdate(uploadState.encryptionKey!, chunk)
        : undefined,
    );
    uploadState.context = context ?? { documentId: uploadState.document };
    uploadState.originalRequestId = originalRequestId ?? uploadState.uploadId;

    for (const chunk of parts) {
      if (chunk.rootHash.length > 0 && !uploadState.fileId) {
        uploadState.fileId = toBase64(chunk.rootHash);
      }

      if (cache) {
        cachedChunks.push({ index: chunk.chunkIndex, data: chunk.chunkData });
      }

      if (skipChunks.has(chunk.chunkIndex)) {
        continue;
      }

      const filePart: FilePartStream = {
        fileId: uploadState.uploadId,
        chunkIndex: chunk.chunkIndex,
        chunkData: chunk.chunkData,
        merkleProof: chunk.merkleProof,
        totalChunks: chunk.totalChunks,
        bytesUploaded: chunk.bytesProcessed,
        encrypted: chunk.encrypted,
      };

      uploadState.unackedChunks.set(chunk.chunkIndex, filePart);

      const message = new RpcMessage<any>(
        uploadState.document,
        { type: "success", payload: filePart },
        "fileUpload",
        "stream",
        uploadState.originalRequestId,
        uploadState.context,
        chunk.encrypted,
      );
      this.#sendStreamMessage(message);
      uploadState.sentChunks.set(message.id, chunk.chunkIndex);
    }

    // Optimistic cache write — before ACKs arrive
    if (cache && uploadState.fileId) {
      const fileId = uploadState.fileId;
      const totalChunks = cachedChunks.length;
      Promise.all([
        ...cachedChunks.map((c) => cache.putChunk(fileId, c.index, c.data)),
        cache.putMetadata(fileId, {
          filename: uploadState.file.name,
          size: uploadState.file.size,
          mimeType: uploadState.file.type || "application/octet-stream",
          encrypted: !!uploadState.encryptionKey,
          totalChunks,
          lastModified: uploadState.file.lastModified,
        }),
      ]).catch(() => {});
    }

    // Mark all chunks as sent - upload can now resolve when all ACKs received
    uploadState.allChunksSent = true;

    // If all ACKs have already been received, resolve now
    if (uploadState.unackedChunks.size === 0) {
      uploadState.resolve(uploadState.fileId!);
      this.#activeUploads.delete(uploadState.uploadId);
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
          handler.resolve(handler.fileId!);
          this.#activeUploads.delete(handler.uploadId);
        }
      } else {
        handler.reject(
          new Error(
            `Upload failed: ${handler.unackedChunks.size} chunks unacknowledged after ${MAX_RETRANSMIT_ROUNDS} retransmission rounds`,
          ),
        );
        this.#activeUploads.delete(handler.uploadId);
      }
    };

    loop().catch(() => {
      handler.retransmitting = false;
    });
  }

  #verifyChunk(chunk: FilePartStream, fileId: string): boolean {
    return verifyMerkleProof(
      chunk.chunkData,
      chunk.merkleProof,
      fromBase64(fileId),
      chunk.chunkIndex,
    );
  }

  async #handleFilePart(payload: FilePartStream, _context?: any) {
    const handler = this.#activeDownloads.get(payload.fileId);
    if (!handler) {
      return;
    }

    if (handler.chunks.has(payload.chunkIndex)) return;

    // Kick off async decrypt before sync verify — Web Crypto runs in native
    // code so the decrypt progresses while we SHA-256 the chunk on the main thread.
    const decryptPromise = handler.encryptionKey
      ? decryptUpdate(handler.encryptionKey, payload.chunkData)
      : null;

    const isValid = this.#verifyChunk(payload, handler.fileId);
    if (!isValid) {
      handler.reject(new Error(`Chunk ${payload.chunkIndex} failed merkle proof verification`));
      this.#activeDownloads.delete(payload.fileId);
      if (handler.timeoutId) {
        clearTimeout(handler.timeoutId);
      }
      return;
    }

    // Cache the verified ciphertext chunk (before decryption)
    if (this.#cache && !handler.skipCache) {
      this.#cache.putChunk(payload.fileId, payload.chunkIndex, payload.chunkData).catch(() => {});
    }

    handler.chunks.set(
      payload.chunkIndex,
      decryptPromise ? await decryptPromise : payload.chunkData,
    );
    this.#checkDownloadCompletion(handler);
  }

  #checkDownloadCompletion(handler: DownloadState) {
    if (!handler.fileMetadata) {
      return;
    }
    const chunkSize = handler.encryptionKey ? ENCRYPTED_CHUNK_SIZE : CHUNK_SIZE;
    const expectedChunks =
      handler.fileMetadata.size === 0 ? 1 : Math.ceil(handler.fileMetadata.size / chunkSize);
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
      } catch (err) {
        handler.reject(err as Error);
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
