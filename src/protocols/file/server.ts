import { createHandlers, ok, type RpcHandlerRegistry, type RpcServerContext } from "teleportal/rpc";
import type { Message } from "teleportal/protocol";
import type { ServerContext } from "teleportal";
import type { FileStorage, TemporaryUploadStorage } from "teleportal/storage";
import { emitWideEvent } from "teleportal/server";
import {
  buildMerkleTree,
  deserializeMerkleTree,
  generateMerkleProof,
} from "teleportal/merkle-tree";
import {
  type FileUploadRequest,
  type FileDownloadResponse,
  type FilePartStream,
  fileProtocol,
} from "./methods";

// ============================================================================
// Constants
// ============================================================================

const MAX_FILE_SIZE = 1024 * 1024 * 1024; // 1GB

// ============================================================================
// Types
// ============================================================================

/**
 * Optional permission checking callbacks for file operations.
 * If not provided, all uploads and downloads are allowed.
 */
export interface FilePermissionOptions {
  /**
   * Check if an upload is allowed. Return `{ allowed: false, reason: "..." }` to reject.
   */
  checkUploadPermission?(
    fileId: string,
    metadata: FileUploadRequest,
    context: RpcServerContext,
  ): Promise<{ allowed: boolean; reason?: string }>;

  /**
   * Check if a download is allowed. Return `{ allowed: false, reason: "..." }` to reject.
   * Can also return metadata to populate the download response.
   */
  checkDownloadPermission?(
    fileId: string,
    context: RpcServerContext,
  ): Promise<{
    allowed: boolean;
    reason?: string;
    metadata?: Omit<FileDownloadResponse, "fileId" | "allowed" | "reason" | "statusCode">;
  }>;
}

// ============================================================================
// FileHandler - Core file handling logic
// ============================================================================

/**
 * Core file handling logic for uploads and downloads.
 * Used internally by the RPC handlers.
 */
export class FileHandler {
  #fileStorage: FileStorage;
  #temporaryUploadStorage: TemporaryUploadStorage | undefined;

  constructor(fileStorage: FileStorage) {
    this.#fileStorage = fileStorage;
    this.#temporaryUploadStorage = fileStorage.temporaryUploadStorage;
  }

  /**
   * Handle an incoming file part (chunk) during upload.
   * Stores the chunk and completes the upload when all chunks arrive.
   */
  async handleFilePart(
    payload: FilePartStream,
    messageId: string,
    sendResponse: (message: Message<ServerContext>) => Promise<void>,
    context: RpcServerContext,
  ): Promise<void> {
    if (!this.#temporaryUploadStorage) {
      throw new Error("File uploads are not enabled: missing fileStorage.temporaryUploadStorage");
    }

    try {
      await this.#temporaryUploadStorage.storeChunk(
        payload.fileId,
        payload.chunkIndex,
        payload.chunkData,
        payload.merkleProof,
      );

      // Only check for completion on the last chunk to avoid per-chunk
      // getUploadProgress calls. Out-of-order delivery is handled by the
      // retransmission loop on the client side.
      if (payload.chunkIndex === payload.totalChunks - 1) {
        const updatedUpload = await this.#temporaryUploadStorage.getUploadProgress(payload.fileId);
        if (updatedUpload && updatedUpload.chunks.size >= payload.totalChunks) {
          const startTime = Date.now();
          try {
            const result = await this.#temporaryUploadStorage.completeUpload(payload.fileId);

            await this.#fileStorage.storeFileFromUpload(result);

            await context.session.storage.transaction(context.documentId, async () => {
              const metadata = await context.session.storage.getDocumentMetadata(
                context.documentId,
              );
              await context.session.storage.writeDocumentMetadata(context.documentId, {
                ...metadata,
                files: [...new Set([...(metadata.files ?? []), result.fileId])],
                updatedAt: Date.now(),
              });
            });
            emitWideEvent("info", {
              event_type: "file_upload_completed",
              timestamp: new Date().toISOString(),
              file_id: payload.fileId,
              total_chunks: payload.totalChunks,
              document_id: context.documentId,
              durable_file_id: result.fileId,
              duration_ms: Date.now() - startTime,
            });
          } catch (error) {
            emitWideEvent("error", {
              event_type: "file_upload_complete_failed",
              timestamp: new Date().toISOString(),
              file_id: payload.fileId,
              document_id: context.documentId,
              error,
              duration_ms: Date.now() - startTime,
            });
            throw error;
          }
        }
      }
    } catch (error) {
      emitWideEvent("error", {
        event_type: "file_part_error",
        file_id: payload.fileId,
        chunk_index: payload.chunkIndex,
        document_id: context.documentId,
        error,
      });
      throw error;
    }
  }

  /**
   * Stream file parts (chunks) for download.
   * Returns an async generator that yields file parts.
   */
  async *streamFileParts(fileId: string): AsyncGenerator<FilePartStream> {
    const file = await this.#fileStorage.getFile(fileId);
    if (!file) {
      emitWideEvent("info", {
        event_type: "file_download_not_found",
        timestamp: new Date().toISOString(),
        file_id: fileId,
        outcome: "not_found",
      });
      throw new Error("File not found");
    }

    emitWideEvent("info", {
      event_type: "file_download_start",
      timestamp: new Date().toISOString(),
      file_id: fileId,
      filename: file.metadata.filename,
      chunk_count: file.chunks.length,
    });

    const chunks = file.chunks;
    const merkleTree = file.serializedMerkleTree
      ? deserializeMerkleTree(file.serializedMerkleTree, chunks.length)
      : await buildMerkleTree(chunks);
    let bytesSent = 0;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const proof = generateMerkleProof(merkleTree, i);
      bytesSent += chunk.length;

      yield {
        fileId: file.id,
        chunkIndex: i,
        chunkData: chunk,
        merkleProof: proof,
        totalChunks: chunks.length,
        bytesUploaded: bytesSent,
        encrypted: file.metadata.encrypted,
      };
    }
  }

  /**
   * Initiate an upload session.
   * Returns the list of chunk indexes already stored (for resumable uploads).
   */
  async initiateUpload(
    fileId: string,
    metadata: {
      filename: string;
      size: number;
      mimeType: string;
      encrypted: boolean;
    },
    document: string,
  ): Promise<{ existingChunks: number[] }> {
    if (!this.#temporaryUploadStorage) {
      throw new Error("File uploads are not enabled: missing fileStorage.temporaryUploadStorage");
    }

    if (metadata.size > MAX_FILE_SIZE) {
      throw new Error(`File size ${metadata.size} exceeds maximum ${MAX_FILE_SIZE} bytes`);
    }

    await this.#temporaryUploadStorage.beginUpload(fileId, {
      filename: metadata.filename,
      size: metadata.size,
      mimeType: metadata.mimeType,
      encrypted: metadata.encrypted,
      lastModified: Date.now(),
      documentId: document,
    });

    const progress = await this.#temporaryUploadStorage.getUploadProgress(fileId);
    const existingChunks = progress ? [...progress.chunks.keys()] : [];

    emitWideEvent("info", {
      event_type: existingChunks.length > 0 ? "file_upload_resumed" : "file_upload_initiated",
      timestamp: new Date().toISOString(),
      file_id: fileId,
      document_id: document,
      filename: metadata.filename,
      size: metadata.size,
      existing_chunks: existingChunks.length,
    });

    return { existingChunks };
  }

  /**
   * Clean up expired uploads.
   */
  async cleanupExpiredUploads(): Promise<void> {
    if (!this.#temporaryUploadStorage) return;
    await this.#temporaryUploadStorage.cleanupExpiredUploads();
  }

  /**
   * Get file metadata for a file.
   */
  async getFileMetadata(fileId: string): Promise<{
    filename: string;
    size: number;
    mimeType: string;
    lastModified: number;
    encrypted: boolean;
  } | null> {
    const file = await this.#fileStorage.getFile(fileId);
    if (!file) {
      return null;
    }
    return {
      filename: file.metadata.filename,
      size: file.metadata.size,
      mimeType: file.metadata.mimeType,
      lastModified: file.metadata.lastModified,
      encrypted: file.metadata.encrypted,
    };
  }
}

// ============================================================================
// Public API
// ============================================================================

interface FileDeps {
  fileHandler: FileHandler;
  permissionOptions?: FilePermissionOptions;
}

/**
 * Create RPC handlers for file upload/download operations.
 *
 * The handlers integrate with the Session RPC system:
 * - `fileUpload`: Handles upload initiation (request) and file parts (stream)
 * - `fileDownload`: Handles download requests and streams file parts back
 *
 * @param fileStorage - The file storage implementation
 * @param options - Optional permission checking callbacks. If not provided, all operations are allowed.
 *
 * @example
 * ```typescript
 * const fileStorage = new InMemoryFileStorage();
 * fileStorage.temporaryUploadStorage = new InMemoryTemporaryUploadStorage();
 *
 * const server = new Server({
 *   getStorage: async () => documentStorage,
 *   rpcHandlers: {
 *     ...getFileRpcHandlers(fileStorage),
 *     ...getMilestoneRpcHandlers(milestoneStorage),
 *   },
 * });
 * ```
 */
export function getFileRpcHandlers(
  fileStorage: FileStorage,
  options?: FilePermissionOptions,
): RpcHandlerRegistry {
  const fileHandler = new FileHandler(fileStorage);
  const deps: FileDeps = { fileHandler, permissionOptions: options };

  return createHandlers(
    fileProtocol,
    deps,
    {
      upload: ({ fileHandler, permissionOptions }) => ({
        handler: async (payload, context) => {
          const permission = permissionOptions?.checkUploadPermission
            ? await permissionOptions.checkUploadPermission(payload.fileId, payload, context)
            : { allowed: true };

          if (!permission.allowed) {
            return ok({
              fileId: payload.fileId,
              allowed: false,
              reason: permission.reason,
              statusCode: 403,
            });
          }

          const { existingChunks } = await fileHandler.initiateUpload(
            payload.fileId,
            {
              filename: payload.filename,
              size: payload.size,
              mimeType: payload.mimeType,
              encrypted: payload.encrypted,
            },
            context.documentId,
          );

          return ok({
            fileId: payload.fileId,
            allowed: true,
            existingChunks: existingChunks.length > 0 ? existingChunks : undefined,
          });
        },
        streamHandler: async (payload, context, messageId, sendMessage) => {
          await fileHandler.handleFilePart(payload, messageId, sendMessage, context);
        },
      }),

      download:
        ({ fileHandler, permissionOptions }) =>
        async (payload, context) => {
          const permission = permissionOptions?.checkDownloadPermission
            ? await permissionOptions.checkDownloadPermission(payload.fileId, context)
            : { allowed: true };

          if (!permission.allowed) {
            return ok({
              fileId: payload.fileId,
              filename: "",
              size: 0,
              mimeType: "",
              lastModified: 0,
              encrypted: false,
              allowed: false,
              reason: permission.reason,
              statusCode: 404,
            });
          }

          let fileMetadata = permission.metadata;
          if (!fileMetadata) {
            const metadata = await fileHandler.getFileMetadata(payload.fileId);
            if (!metadata) {
              return ok({
                fileId: payload.fileId,
                filename: "",
                size: 0,
                mimeType: "",
                lastModified: 0,
                encrypted: false,
                allowed: false,
                reason: "File not found",
                statusCode: 404,
              });
            }
            fileMetadata = metadata;
          }

          const stream = fileHandler.streamFileParts(payload.fileId);

          return ok(
            {
              fileId: payload.fileId,
              allowed: true,
              filename: fileMetadata.filename,
              size: fileMetadata.size,
              mimeType: fileMetadata.mimeType,
              lastModified: fileMetadata.lastModified,
              encrypted: fileMetadata.encrypted,
            },
            { stream },
          );
        },
    },
    {
      init: (_server, { fileHandler }) => {
        const cleanupInterval = setInterval(
          async () => {
            try {
              await fileHandler.cleanupExpiredUploads();
            } catch (error) {
              emitWideEvent("error", {
                event_type: "file_cleanup_expired_failed",
                timestamp: new Date().toISOString(),
                error,
              });
            }
          },
          5 * 60 * 1000,
        );

        return () => {
          clearInterval(cleanupInterval);
        };
      },
    },
  );
}
