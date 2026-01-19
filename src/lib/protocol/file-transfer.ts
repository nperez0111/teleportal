import { toBase64 } from "lib0/buffer";
import { uuidv4 } from "lib0/random";
import {
  CHUNK_SIZE,
  createMerkleTreeTransformStream,
  ENCRYPTED_CHUNK_SIZE,
} from "teleportal/merkle-tree";
import { AckMessage, type Message } from "./message-types";
import { decryptUpdate, encryptUpdate } from "teleportal/encryption-key";
import { RpcMessage } from "teleportal/protocol";
import type { FilePartStream } from "../../protocols/file/methods";

export namespace FileTransferProtocol {
  export interface UploadState {
    resolve: (fileId: string) => void;
    reject: (error: Error) => void;
    uploadId: string;
    file: File;
    fileId: string | null;
    sentChunks: Set<string>;
    document: string;
    encryptionKey?: CryptoKey;
  }

  export interface DownloadState {
    resolve: (file: File) => void;
    reject: (error: Error) => void;
    fileMetadata: { filename: string; size: number; mimeType: string } | null;
    chunks: Map<number, Uint8Array>;
    fileId: string;
    timeoutId: ReturnType<typeof setTimeout> | null;
    encryptionKey?: CryptoKey;
  }

  export abstract class Client<Context extends Record<string, unknown> = any> {
    protected activeUploads = new Map<string, UploadState>();
    protected activeDownloads = new Map<string, DownloadState>();

    abstract sendMessage(message: Message<Context>): void;

    async requestUpload(
      file: File,
      document: string,
      fileId: string = uuidv4(),
      encryptionKey?: CryptoKey,
      context?: Context,
    ): Promise<string> {
      const uploadPromise = new Promise<string>((resolve, reject) => {
        this.activeUploads.set(fileId, {
          resolve,
          reject,
          uploadId: fileId,
          fileId: null,
          file,
          sentChunks: new Set(),
          document,
          encryptionKey,
        });
      });

      let encryptionOverhead = 0;
      if (encryptionKey) {
        const numberOfChunks = Math.ceil(file.size / CHUNK_SIZE);
        encryptionOverhead =
          numberOfChunks * (CHUNK_SIZE - ENCRYPTED_CHUNK_SIZE);
      }

      const requestPayload: Record<string, unknown> = {
        method: "fileUpload",
        fileId,
        filename: file.name,
        size: file.size + encryptionOverhead,
        mimeType: file.type || "application/octet-stream",
        lastModified: file.lastModified,
        encrypted: !!encryptionKey,
      };
      this.sendMessage(
        new RpcMessage(
          document,
          { type: "success", payload: requestPayload },
          "fileUpload",
          "request",
          undefined,
          context,
          !!encryptionKey,
        ),
      );

      return uploadPromise;
    }

    async requestDownload(
      fileId: string,
      document: string,
      encryptionKey?: CryptoKey,
      timeout: number = 60000,
      context?: Context,
    ): Promise<File> {
      let timeoutId: ReturnType<typeof setTimeout> | null = null;

      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          const handler = this.activeDownloads.get(fileId);
          if (handler) {
            handler.reject(new Error(`Download timeout after ${timeout}ms`));
            this.activeDownloads.delete(fileId);
          }
          reject(new Error(`Download timeout after ${timeout}ms`));
        }, timeout);
      });

      const downloadPromise = new Promise<File>((resolve, reject) => {
        this.activeDownloads.set(fileId, {
          resolve,
          reject,
          fileMetadata: null,
          chunks: new Map(),
          fileId,
          timeoutId,
          encryptionKey,
        });
      });

      const requestPayload: Record<string, unknown> = {
        method: "fileDownload",
        fileId,
      };
      this.sendMessage(
        new RpcMessage(
          document,
          { type: "success", payload: requestPayload },
          "fileDownload",
          "request",
          undefined,
          context,
          !!encryptionKey,
        ),
      );

      try {
        return await Promise.race([downloadPromise, timeoutPromise]);
      } finally {
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
        }
      }
    }

    abstract onDownloadComplete(
      state: DownloadState,
      file: File,
    ): void | Promise<void>;

    async handleMessage(message: Message<Context>): Promise<boolean> {
      if (message.type === "ack") {
        return this.handleAck(message as AckMessage<Context>);
      }

      if (message.type === "rpc") {
        const rpcMessage = message as RpcMessage<Context>;

        // Handle RPC stream messages (file parts)
        if (rpcMessage.requestType === "stream") {
          if (rpcMessage.payload.type === "success") {
            await this.handleFilePart(rpcMessage.payload.payload as FilePartStream, rpcMessage.context);
            return true;
          }
        }

        // Handle RPC response messages
        return this.handleRpcResponse(rpcMessage);
      }

      return false;
    }

    protected handleAck(message: AckMessage<Context>) {
      let resolved = false;
      for (const handler of this.activeUploads.values()) {
        if (handler.sentChunks.delete(message.payload.messageId)) {
          resolved = true;
          if (handler.sentChunks.size === 0) {
            handler.resolve(handler.fileId!);
            this.activeUploads.delete(handler.uploadId);
          }
        }
      }
      return resolved;
    }

    protected handleRpcResponse(message: RpcMessage<Context>) {
      if (message.requestType !== "response") {
        return false;
      }

      const payload = message.payload as {
        type: "success" | "error";
        payload?: {
          fileId: string;
          filename: string;
          size: number;
          mimeType: string;
        };
        details?: string;
      };

      if (payload.type === "success" && payload.payload) {
        const downloadHandler = this.activeDownloads.get(
          payload.payload.fileId,
        );
        if (downloadHandler) {
          downloadHandler.fileMetadata = {
            filename: payload.payload.filename,
            size: payload.payload.size,
            mimeType: payload.payload.mimeType,
          };
          // Check if download is complete (file parts may have arrived before this response)
          this.checkDownloadCompletion(downloadHandler);
        }

        const uploadHandler = this.activeUploads.get(payload.payload.fileId);
        if (uploadHandler) {
          this.processFileUpload(uploadHandler, message.context);
        }
      } else if (payload.type === "error") {
        if (this.activeDownloads.has(message.originalRequestId!)) {
          this.activeDownloads
            .get(message.originalRequestId!)
            ?.reject(
              new Error(payload.details || "Download permission denied"),
            );
          this.activeDownloads.delete(message.originalRequestId!);
        }
      }

      return true;
    }

    protected async processFileUpload(
      uploadState: UploadState,
      context?: Context,
      originalRequestId?: string,
    ) {
      const transformStream = createMerkleTreeTransformStream(
        uploadState.file.size,
        uploadState.encryptionKey
          ? (chunk: Uint8Array) =>
              encryptUpdate(uploadState.encryptionKey!, chunk)
          : undefined,
      );

      return uploadState.file
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

              const message = new RpcMessage<Context>(
                uploadState.document,
                { type: "success", payload: filePart },
                "fileUpload",
                "stream",
                originalRequestId ?? uploadState.uploadId,
                context ?? ({} as Context),
                chunk.encrypted,
              );

              uploadState.sentChunks.add(message.id);

              this.sendMessage(message);
            },
          }),
        );
    }

    protected abstract verifyChunk(
      chunk: FilePartStream,
      fileId: string,
    ): boolean;

    protected async handleFilePart(payload: FilePartStream, context?: Context) {
      const handler = this.activeDownloads.get(payload.fileId);
      if (!handler) {
        return;
      }

      const isValid = this.verifyChunk(payload, handler.fileId);
      if (!isValid) {
        handler.reject(
          new Error(
            `Chunk ${payload.chunkIndex} failed merkle proof verification`,
          ),
        );
        this.activeDownloads.delete(payload.fileId);
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
        await this.checkDownloadCompletion(handler);
      }
    }

    private async checkDownloadCompletion(handler: DownloadState) {
      if (!handler.fileMetadata) {
        return;
      }
      const chunkSize = handler.encryptionKey
        ? ENCRYPTED_CHUNK_SIZE
        : CHUNK_SIZE;
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
          await this.onDownloadComplete(handler, file);
          handler.resolve(file);
        } catch (err) {
          handler.reject(err as Error);
        } finally {
          this.activeDownloads.delete(handler.fileId);
        }
      }
    }
  }

  export abstract class Server<Context extends Record<string, unknown> = any> {
    async handleMessage(
      message: Message<Context>,
      sendMessage: (message: Message<Context>) => Promise<void>,
    ): Promise<void> {
      if (message.type !== "rpc") {
        throw new Error("ServerFileHandler can only handle RPC messages");
      }

      const rpcMessage = message as RpcMessage<Context>;

      // Handle RPC stream messages (file parts)
      if (rpcMessage.requestType === "stream" && rpcMessage.payload.type === "success") {
        await this.onChunkReceived(
          rpcMessage.payload.payload as FilePartStream,
          message.id,
          rpcMessage.document ?? "",
          rpcMessage.context,
          sendMessage,
        );
        return;
      }

      // Handle RPC request messages
      if (rpcMessage.requestType === "request") {
        return this.handleRpcRequest(rpcMessage, sendMessage);
      }
    }

    protected async handleRpcRequest(
      message: RpcMessage<Context>,
      sendMessage: (message: Message<Context>) => Promise<void>,
    ) {
      if (message.requestType !== "request") {
        return;
      }

      if (message.payload.type !== "success") {
        return;
      }

      const method = message.rpcMethod;
      const requestPayload = message.payload.payload as {
        fileId?: string;
        filename?: string;
        size?: number;
        mimeType?: string;
        lastModified?: number;
        encrypted?: boolean;
      };
      const payload = {
        fileId: requestPayload.fileId,
        filename: requestPayload.filename,
        size: requestPayload.size,
        mimeType: requestPayload.mimeType,
        lastModified: requestPayload.lastModified,
        encrypted: requestPayload.encrypted,
      } as {
        fileId: string;
        filename?: string;
        size?: number;
        mimeType?: string;
        lastModified?: number;
        encrypted?: boolean;
      };

      if (method === "fileUpload") {
        const allowed = await this.checkUploadPermission(
          payload,
          message.context,
        );
        if (!allowed.allowed) {
          await sendMessage(
            new RpcMessage(
              message.document,
              {
                type: "error",
                statusCode: 403,
                details: allowed.reason || "Upload permission denied",
              },
              method,
              "response",
              message.id,
              message.context,
              message.encrypted,
            ),
          );
          return;
        }

        try {
          await this.onUploadStart(
            payload,
            message.context,
            message.document ?? "",
            message.encrypted,
          );
          await sendMessage(
            new RpcMessage(
              message.document ?? "",
              {
                type: "success",
                payload: { fileId: payload.fileId },
              },
              method,
              "response",
              message.id,
              message.context,
              message.encrypted,
            ),
          );
        } catch (error) {
          await sendMessage(
            new RpcMessage(
              message.document ?? "",
              {
                type: "error",
                statusCode: 500,
                details: (error as Error).message,
              },
              method,
              "response",
              message.id,
              message.context,
              message.encrypted,
            ),
          );
        }
      } else if (method === "fileDownload") {
        await this.onDownloadRequest(
          payload,
          message.context,
          message.document ?? "",
          message.encrypted,
          sendMessage,
          message,
        );
      }
    }

    protected async checkUploadPermission(
      metadata: {
        fileId: string;
        filename?: string;
        size?: number;
        mimeType?: string;
        lastModified?: number;
        encrypted?: boolean;
      },
      context: Context,
    ): Promise<{ allowed: boolean; reason?: string }> {
      return { allowed: true };
    }

    protected async onUploadStart(
      metadata: {
        fileId: string;
        filename?: string;
        size?: number;
        mimeType?: string;
        lastModified?: number;
        encrypted?: boolean;
      },
      context: Context,
      document: string,
      encrypted: boolean,
    ): Promise<void> {}

    protected async onChunkReceived(
      payload: FilePartStream,
      messageId: string,
      document: string,
      context: Context,
      sendMessage: (message: Message<Context>) => Promise<void>,
    ): Promise<void> {
      await sendMessage(
        new AckMessage({
          type: "ack",
          messageId,
        }),
      );
    }

    protected async onDownloadRequest(
      payload: { fileId: string },
      context: Context,
      document: string,
      encrypted: boolean,
      sendMessage: (message: Message<Context>) => Promise<void>,
      originalMessage: RpcMessage<Context>,
    ): Promise<void> {
      await sendMessage(
        new RpcMessage(
          document,
          {
            type: "error",
            statusCode: 404,
            details: "File not found",
          },
          originalMessage.rpcMethod,
          "response",
          originalMessage.id,
          context,
          encrypted,
        ),
      );
    }
  }
}
