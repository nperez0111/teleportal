import type { AckMessage, RpcMessage } from "teleportal/protocol";
import { RpcOperationError, type RpcExtension, type RpcExtensionContext } from "teleportal/rpc";
import { getFileClientHandlers, type FileClientHandlerOptions } from "./transfer";
import type { FileCache } from "../../storage/idb/file-cache";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FileRpcOptions {
  encryptionKey?: CryptoKey;
  cache?: FileCache;
}

export interface FileUploadOptions {
  fileId?: string;
  encryptionKey?: CryptoKey;
  cache?: boolean;
}

export interface FileDownloadOptions {
  encryptionKey?: CryptoKey;
  timeout?: number;
  cache?: boolean;
}

export interface FileRpc {
  upload(file: File, options?: FileUploadOptions): Promise<string>;
  download(fileId: string, options?: FileDownloadOptions): Promise<File>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a file RPC extension for use with the Provider extension system.
 *
 * The file protocol is the "streaming escape hatch" — it uses the
 * `FileClientHandler` state machine directly rather than `createClientExtension`,
 * since file transfers require bidirectional message routing (handleMessage/handleAck).
 *
 * @example
 * ```ts
 * import { createFileRpc } from "teleportal/protocols/file";
 * import { createEncryptionKey } from "teleportal/encryption-key";
 * import { IdbFileCache } from "teleportal/storage";
 *
 * const encryptionKey = await createEncryptionKey();
 * const cache = new IdbFileCache();
 *
 * const provider = await Provider.create({
 *   url: "wss://...",
 *   document: "my-doc",
 *   encryptionKey,
 *   rpc: {
 *     file: () => createFileRpc({ encryptionKey, cache }),
 *   },
 * });
 *
 * const fileId = await provider.rpc.file.upload(myFile);
 * const file   = await provider.rpc.file.download(fileId);
 * ```
 */
export function createFileRpc(options?: FileRpcOptions): RpcExtension<FileRpc> {
  const handlerOptions: FileClientHandlerOptions = {
    encryptionKey: options?.encryptionKey,
    cache: options?.cache,
  };
  const handlers = getFileClientHandlers(handlerOptions);
  const handler = handlers.fileUpload as any;

  let document: string;

  return {
    create(ctx: RpcExtensionContext): FileRpc {
      document = ctx.document;

      handler.setRpcClient(ctx.rpcClient, async (msg: RpcMessage<any>) => {
        await ctx.rpcClient.sendStream(msg);
      });

      return {
        async upload(file: File, opts?: FileUploadOptions): Promise<string> {
          try {
            return await handler.uploadFile(
              file,
              document,
              opts?.fileId,
              opts?.encryptionKey ?? ctx.encryptionKey,
              opts?.cache === false ? true : undefined,
            );
          } catch (error) {
            throw new RpcOperationError("file", "upload", error);
          }
        },

        async download(fileId: string, opts?: FileDownloadOptions): Promise<File> {
          try {
            return await handler.downloadFile(
              fileId,
              document,
              opts?.encryptionKey ?? ctx.encryptionKey,
              opts?.timeout,
              opts?.cache === false ? true : undefined,
            );
          } catch (error) {
            throw new RpcOperationError("file", "download", error);
          }
        },
      };
    },

    handleMessage(message: RpcMessage<any>): boolean {
      if (message.requestType === "response") {
        return handler.handleResponse(message);
      }
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
