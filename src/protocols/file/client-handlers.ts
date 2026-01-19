import { toBase64, fromBase64 } from "lib0/buffer";
import { uuidv4 } from "lib0/random";
import {
  CHUNK_SIZE,
  createMerkleTreeTransformStream,
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

interface UploadState {
  resolve: (fileId: string) => void;
  reject: (error: Error) => void;
  uploadId: string;
  file: File;
  fileId: string | null;
  sentChunks: Set<string>;
  document: string;
  encryptionKey?: CryptoKey;
  /** True when all chunks have been sent (file streaming complete) */
  allChunksSent: boolean;
}

interface DownloadState {
  resolve: (file: File) => void;
  reject: (error: Error) => void;
  fileMetadata: { filename: string; size: number; mimeType: string } | null;
  chunks: Map<number, Uint8Array>;
  fileId: string;
  timeoutId: ReturnType<typeof setTimeout> | null;
  encryptionKey?: CryptoKey;
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
}

class FileClientHandler implements ClientRpcHandler {
  #activeUploads = new Map<string, UploadState>();
  #activeDownloads = new Map<string, DownloadState>();
  #downloadCache = new Map<string, Promise<File>>();
  #provider: Provider<any> | null = null;
  #rpcClient: RpcClient | null = null;
  #sendStreamMessage: ((message: Message<any>) => Promise<void>) | null = null;
  #encryptionKey?: CryptoKey;

  constructor(options?: FileClientHandlerOptions) {
    this.#encryptionKey = options?.encryptionKey;
  }

  init(provider: Provider<any>): void {
    this.#provider = provider;
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
        sentChunks: new Set(),
        document,
        encryptionKey: key,
        allChunksSent: false,
      });
    });

    let encryptionOverhead = 0;
    if (key) {
      const numberOfChunks = Math.ceil(file.size / CHUNK_SIZE);
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
  ): Promise<File> {
    if (!this.#rpcClient) {
      throw new Error("File handler not initialized");
    }

    const key = encryptionKey ?? this.#encryptionKey;

    // Check cache first
    const cached = this.#downloadCache.get(fileId);
    if (cached) {
      return cached;
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
      });
    });

    const promise = Promise.race([downloadPromise, timeoutPromise]);
    this.#downloadCache.set(fileId, promise);

    const requestPayload: Record<string, unknown> = {
      method: "fileDownload",
      fileId,
    };

    try {
      await this.#rpcClient.sendRequest(
        document,
        "fileDownload",
        requestPayload,
        {
          timeout,
          onStream: (payload) => {
            // Stream messages are handled via handleStream
            // This is just for tracking
          },
        },
      );
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
      };
      details?: string;
    };

    if (payload.type === "success" && payload.payload) {
      // Check if this is a download response (has metadata)
      if (payload.payload.filename !== undefined) {
        const downloadHandler = this.#activeDownloads.get(
          payload.payload.fileId,
        );
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
        this.#processFileUpload(uploadHandler, message.context).catch(
          (error) => {
            uploadHandler.reject(error);
            this.#activeUploads.delete(uploadHandler.uploadId);
          },
        );
        return true;
      }
    } else if (payload.type === "error") {
      // Handle error responses - check by original request ID first
      const uploadHandler = this.#activeUploads.get(message.originalRequestId!);
      if (uploadHandler) {
        uploadHandler.reject(
          new Error(payload.details || "Upload permission denied"),
        );
        this.#activeUploads.delete(uploadHandler.uploadId);
        return true;
      }

      const downloadHandler = this.#activeDownloads.get(
        message.originalRequestId!,
      );
      if (downloadHandler) {
        downloadHandler.reject(
          new Error(payload.details || "Download permission denied"),
        );
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
      if (handler.sentChunks.delete(ackMessage.payload.messageId)) {
        handled = true;
        // Only resolve when ALL chunks have been sent AND all ACKs received
        // This prevents premature resolution if ACKs arrive before all chunks are sent
        if (handler.allChunksSent && handler.sentChunks.size === 0) {
          handler.resolve(handler.fileId!);
          this.#activeUploads.delete(handler.uploadId);
        }
      }
    }

    return handled;
  }

  async #processFileUpload(
    uploadState: UploadState,
    context?: any,
    originalRequestId?: string,
  ) {
    if (!this.#sendStreamMessage) {
      throw new Error("File handler not initialized");
    }

    const transformStream = createMerkleTreeTransformStream(
      uploadState.file.size,
      uploadState.encryptionKey
        ? (chunk: Uint8Array) =>
            encryptUpdate(uploadState.encryptionKey!, chunk)
        : undefined,
    );

    await uploadState.file
      .stream()
      .pipeThrough(transformStream)
      .pipeTo(
        new WritableStream({
          write: async (chunk) => {
            if (chunk.rootHash.length > 0 && !uploadState.fileId) {
              uploadState.fileId = toBase64(chunk.rootHash);
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

            const message = new RpcMessage<any>(
              uploadState.document,
              { type: "success", payload: filePart },
              "fileUpload",
              "stream",
              originalRequestId ?? uploadState.uploadId,
              context ?? { documentId: uploadState.document },
              chunk.encrypted,
            );

            uploadState.sentChunks.add(message.id);

            if (this.#sendStreamMessage) {
              await this.#sendStreamMessage(message);
            }
          },
        }),
      );

    // Mark all chunks as sent - upload can now resolve when all ACKs received
    uploadState.allChunksSent = true;

    // If all ACKs have already been received, resolve now
    if (uploadState.sentChunks.size === 0) {
      uploadState.resolve(uploadState.fileId!);
      this.#activeUploads.delete(uploadState.uploadId);
    }
  }

  #verifyChunk(chunk: FilePartStream, fileId: string): boolean {
    return verifyMerkleProof(
      chunk.chunkData,
      chunk.merkleProof,
      fromBase64(fileId),
      chunk.chunkIndex,
    );
  }

  async #handleFilePart(payload: FilePartStream, context?: any) {
    const handler = this.#activeDownloads.get(payload.fileId);
    if (!handler) {
      return;
    }

    const isValid = this.#verifyChunk(payload, handler.fileId);
    if (!isValid) {
      handler.reject(
        new Error(
          `Chunk ${payload.chunkIndex} failed merkle proof verification`,
        ),
      );
      this.#activeDownloads.delete(payload.fileId);
      if (handler.timeoutId) {
        clearTimeout(handler.timeoutId);
      }
      return;
    }

    if (!handler.chunks.has(payload.chunkIndex)) {
      if (handler.encryptionKey) {
        payload.chunkData = await decryptUpdate(
          handler.encryptionKey,
          payload.chunkData,
        );
      }
      handler.chunks.set(payload.chunkIndex, payload.chunkData);
      await this.#checkDownloadCompletion(handler);
    }
  }

  async #checkDownloadCompletion(handler: DownloadState) {
    if (!handler.fileMetadata) {
      return;
    }
    const chunkSize = handler.encryptionKey ? ENCRYPTED_CHUNK_SIZE : CHUNK_SIZE;
    const expectedChunks =
      handler.fileMetadata.size === 0
        ? 1
        : Math.ceil(handler.fileMetadata.size / chunkSize);
    if (handler.chunks.size >= expectedChunks) {
      try {
        const fileData = new Uint8Array(expectedChunks * CHUNK_SIZE);
        let offset = 0;
        for (let i = 0; i < expectedChunks; i++) {
          const chunk = handler.chunks.get(i);
          if (!chunk) {
            throw new Error(`Missing chunk ${i}`);
          }
          fileData.set(chunk, offset);
          offset += chunk.length;
        }
        const file = new File(
          [fileData.slice(0, offset)],
          handler.fileMetadata.filename,
          {
            type: handler.fileMetadata.mimeType,
          },
        );
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
 *
 * const provider = await Provider.create({
 *   url: "wss://...",
 *   document: "my-doc",
 *   encryptionKey: myKey, // optional
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
