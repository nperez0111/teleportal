import type { AckMessage, RpcMessage } from "teleportal/protocol";
import { RpcOperationError, type RpcExtension, type RpcExtensionContext } from "teleportal/rpc";
import { getFileClientHandlers, type FileClientHandlerOptions } from "./transfer";

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
 *
 * const encryptionKey = await createEncryptionKey();
 *
 * const provider = await Provider.create({
 *   url: "wss://...",
 *   document: "my-doc",
 *   encryptionKey,
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
  const handlerOptions: FileClientHandlerOptions = {
    encryptionKey: options?.encryptionKey,
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
        async upload(file: File, fileId?: string, encryptionKey?: CryptoKey): Promise<string> {
          try {
            return await handler.uploadFile(
              file,
              document,
              fileId,
              encryptionKey ?? ctx.encryptionKey,
            );
          } catch (error) {
            throw new RpcOperationError("file", "upload", error);
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
