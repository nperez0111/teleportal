import type { AckMessage, RpcMessage } from "teleportal/protocol";
import type { RpcExtension, RpcExtensionContext } from "../../providers/rpc-extension";
import { getFileClientHandlers, type FileClientHandlerOptions } from "./client-handlers";

// ---------------------------------------------------------------------------
// Error types (mirrored from provider.ts for standalone use)
// ---------------------------------------------------------------------------

/**
 * Error thrown when a file operation is denied by the server.
 */
export class FileOperationDeniedError extends Error {
  constructor(public readonly reason: string) {
    super(`File operation denied: ${reason}`);
    this.name = "FileOperationDeniedError";
  }
}

/**
 * Error thrown when a file operation fails.
 */
export class FileOperationError extends Error {
  constructor(
    public readonly operation: string,
    cause?: unknown,
  ) {
    const message =
      cause instanceof Error
        ? `Failed to ${operation}: ${cause.message}`
        : `Failed to ${operation}: ${String(cause)}`;
    super(message, { cause });
    this.name = "FileOperationError";
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FileRpcOptions {
  encryptionKey?: CryptoKey;
}

export interface FileRpc {
  upload(file: File, fileId?: string, encryptionKey?: CryptoKey): Promise<string>;
  download(fileId: string, encryptionKey?: CryptoKey, timeout?: number): Promise<File>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a file RPC extension for use with the new Provider extension system.
 *
 * @example
 * ```ts
 * import { createFileRpc } from "teleportal/protocols/file";
 *
 * const provider = await Provider.create({
 *   url: "wss://...",
 *   document: "my-doc",
 *   rpc: {
 *     file: () => createFileRpc({ encryptionKey }),
 *   },
 * });
 *
 * const fileId = await provider.rpc.file.upload(myFile);
 * const file   = await provider.rpc.file.download(fileId);
 * ```
 */
export function createFileRpc(options?: FileRpcOptions): RpcExtension<FileRpc> {
  // The handler instance is shared between upload & download.
  // getFileClientHandlers returns { fileUpload, fileDownload } pointing at the
  // same FileClientHandler – we only need one reference.
  const handlerOptions: FileClientHandlerOptions = {
    encryptionKey: options?.encryptionKey,
  };
  const handlers = getFileClientHandlers(handlerOptions);
  // Both keys reference the same instance – grab either one.
  const handler = handlers.fileUpload as any;

  let document: string;

  return {
    create(ctx: RpcExtensionContext): FileRpc {
      document = ctx.document;

      // Wire the handler to the RPC client + stream sender.
      handler.setRpcClient(ctx.rpcClient, async (msg: RpcMessage<any>) => {
        await ctx.rpcClient.sendStream(msg);
      });

      return {
        async upload(file: File, fileId?: string, encryptionKey?: CryptoKey): Promise<string> {
          try {
            return await handler.uploadFile(
              file,
              document,
              fileId,
              encryptionKey ?? ctx.encryptionKey,
            );
          } catch (error) {
            if (error instanceof FileOperationDeniedError) {
              throw error;
            }
            throw new FileOperationError("upload file", error);
          }
        },

        async download(fileId: string, encryptionKey?: CryptoKey, timeout?: number): Promise<File> {
          try {
            return await handler.downloadFile(
              fileId,
              document,
              encryptionKey ?? ctx.encryptionKey,
              timeout,
            );
          } catch (error) {
            if (error instanceof FileOperationDeniedError) {
              throw error;
            }
            throw new FileOperationError("download file", error);
          }
        },
      };
    },

    handleMessage(message: RpcMessage<any>): boolean {
      // Route response messages
      if (message.requestType === "response") {
        return handler.handleResponse(message);
      }
      // Route stream messages (file part chunks during download)
      if (message.requestType === "stream") {
        return handler.handleStream(message);
      }
      return false;
    },

    handleAck(message: AckMessage<any>): boolean {
      return handler.handleAck(message as any);
    },
  };
}
