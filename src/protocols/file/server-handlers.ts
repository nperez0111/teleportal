import {
  RpcServerContext,
  RpcHandlerRegistry,
  RpcServerRequestHandler,
  RpcError,
  type Message,
  AckMessage,
} from "teleportal/protocol";
import type { ServerContext } from "teleportal";
import type { FileStorage, TemporaryUploadStorage } from "teleportal/storage";
import { getLogger, Logger } from "@logtape/logtape";
import { buildMerkleTree, generateMerkleProof } from "teleportal/merkle-tree";
import { toErrorDetails } from "../../logging";
import {
  FileUploadRequest,
  FileDownloadRequest,
  FileUploadResponse,
  FileDownloadResponse,
  type FilePartStream,
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
    metadata?: Omit<
      FileDownloadResponse,
      "fileId" | "allowed" | "reason" | "statusCode"
    >;
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
  #logger: Logger;

  constructor(fileStorage: FileStorage) {
    this.#fileStorage = fileStorage;
    this.#temporaryUploadStorage = fileStorage.temporaryUploadStorage;
    this.#logger = getLogger(["teleportal", "protocols", "file", "handler"]);
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
    const log = this.#logger.with({
      fileId: payload.fileId,
      chunkIndex: payload.chunkIndex,
      totalChunks: payload.totalChunks,
      bytesUploaded: payload.bytesUploaded,
    });

    log.debug("Handling file progress");

    if (!this.#temporaryUploadStorage) {
      throw new Error(
        "File uploads are not enabled: missing fileStorage.temporaryUploadStorage",
      );
    }

    const upload = await this.#temporaryUploadStorage.getUploadProgress(
      payload.fileId,
    );
    if (!upload) {
      const error = new Error(`Upload session ${payload.fileId} not found`);
      log.error("Upload session not found", {
        error: toErrorDetails(error),
      });
      throw error;
    }

    try {
      await this.#temporaryUploadStorage.storeChunk(
        payload.fileId,
        payload.chunkIndex,
        payload.chunkData,
        payload.merkleProof,
      );

      await sendResponse(
        new AckMessage({
          type: "ack",
          messageId,
        }),
      );

      const updatedUpload =
        await this.#temporaryUploadStorage.getUploadProgress(payload.fileId);
      if (!updatedUpload) {
        throw new Error(
          `Upload session ${payload.fileId} not found after storing chunk`,
        );
      }

      if (updatedUpload.chunks.size >= payload.totalChunks) {
        try {
          const result = await this.#temporaryUploadStorage.completeUpload(
            payload.fileId,
          );
          log.debug("Upload completed successfully", {
            uploadId: payload.fileId,
            fileId: result.fileId,
          });

          await this.#fileStorage.storeFileFromUpload(result);
          log.debug("File moved to durable storage", {
            fileId: result.fileId,
          });

          // Update document metadata to include the new file
          await context.session.storage.transaction(
            context.documentId,
            async () => {
              const metadata =
                await context.session.storage.getDocumentMetadata(
                  context.documentId,
                );
              await context.session.storage.writeDocumentMetadata(
                context.documentId,
                {
                  ...metadata,
                  files: [
                    ...new Set([...(metadata.files ?? []), result.fileId]),
                  ],
                  updatedAt: Date.now(),
                },
              );
            },
          );
          log.debug("Document metadata updated with file", {
            fileId: result.fileId,
            documentId: context.documentId,
          });
        } catch (error) {
          log.error("Failed to complete upload", {
            fileId: payload.fileId,
            error: toErrorDetails(error),
          });
          throw error;
        }
      }

      log.debug("Chunk stored successfully");
    } catch (error) {
      log.error("Failed to store chunk", {
        fileId: payload.fileId,
        chunkIndex: payload.chunkIndex,
        error: toErrorDetails(error),
      });
      throw error;
    }
  }

  /**
   * Stream file parts (chunks) for download.
   * Returns an async generator that yields file parts.
   */
  async *streamFileParts(fileId: string): AsyncGenerator<FilePartStream> {
    const log = this.#logger.with({ fileId, direction: "download" });

    const file = await this.#fileStorage.getFile(fileId);
    if (!file) {
      log.info("File not found for download", { fileId });
      throw new Error("File not found");
    }

    log.debug("File found for download", {
      fileId,
      filename: file.metadata.filename,
    });

    const chunks = file.chunks;
    const merkleTree = buildMerkleTree(chunks);
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
  ): Promise<void> {
    if (!this.#temporaryUploadStorage) {
      throw new Error(
        "File uploads are not enabled: missing fileStorage.temporaryUploadStorage",
      );
    }

    if (metadata.size > MAX_FILE_SIZE) {
      throw new Error(
        `File size ${metadata.size} exceeds maximum ${MAX_FILE_SIZE} bytes`,
      );
    }

    await this.#temporaryUploadStorage.beginUpload(fileId, {
      filename: metadata.filename,
      size: metadata.size,
      mimeType: metadata.mimeType,
      encrypted: metadata.encrypted,
      lastModified: Date.now(),
      documentId: document,
    });

    this.#logger.with({ uploadId: fileId }).debug("Upload session initiated");
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
// RPC Handler Factories
// ============================================================================

/**
 * Create the upload request handler.
 */
function createUploadHandler(
  fileHandler: FileHandler,
  options?: FilePermissionOptions,
) {
  return async (
    payload: FileUploadRequest,
    context: RpcServerContext,
  ): Promise<{ response: FileUploadResponse | RpcError }> => {
    try {
      const permission = options?.checkUploadPermission
        ? await options.checkUploadPermission(payload.fileId, payload, context)
        : { allowed: true };

      if (!permission.allowed) {
        return {
          response: {
            fileId: payload.fileId,
            allowed: false,
            reason: permission.reason,
            statusCode: 403,
          },
        };
      }

      await fileHandler.initiateUpload(
        payload.fileId,
        {
          filename: payload.filename,
          size: payload.size,
          mimeType: payload.mimeType,
          encrypted: payload.encrypted,
        },
        context.documentId,
      );

      return {
        response: {
          fileId: payload.fileId,
          allowed: true,
        },
      };
    } catch (error) {
      return {
        response: {
          type: "error",
          statusCode: 500,
          details:
            error instanceof Error
              ? error.message
              : "Failed to initiate upload",
        },
      };
    }
  };
}

/**
 * Create the upload stream handler for file parts.
 */
function createUploadStreamHandler(fileHandler: FileHandler) {
  return async (
    payload: FilePartStream,
    context: RpcServerContext,
    messageId: string,
    sendMessage: (message: Message<ServerContext>) => Promise<void>,
  ): Promise<void> => {
    await fileHandler.handleFilePart(payload, messageId, sendMessage, context);
  };
}

/**
 * Create the download request handler.
 * Returns file metadata and a stream of file parts.
 */
function createDownloadHandler(
  fileHandler: FileHandler,
  options?: FilePermissionOptions,
) {
  return async (
    payload: FileDownloadRequest,
    context: RpcServerContext,
  ): Promise<{
    response: FileDownloadResponse | RpcError;
    stream?: AsyncIterable<FilePartStream>;
  }> => {
    try {
      const permission = options?.checkDownloadPermission
        ? await options.checkDownloadPermission(payload.fileId, context)
        : { allowed: true };

      if (!permission.allowed) {
        return {
          response: {
            fileId: payload.fileId,
            filename: "",
            size: 0,
            mimeType: "",
            lastModified: 0,
            encrypted: false,
            allowed: false,
            reason: permission.reason,
            statusCode: 404,
          },
        };
      }

      // Get file metadata from storage
      let fileMetadata = permission.metadata;
      if (!fileMetadata) {
        const metadata = await fileHandler.getFileMetadata(payload.fileId);
        if (!metadata) {
          return {
            response: {
              fileId: payload.fileId,
              filename: "",
              size: 0,
              mimeType: "",
              lastModified: 0,
              encrypted: false,
              allowed: false,
              reason: "File not found",
              statusCode: 404,
            },
          };
        }
        fileMetadata = metadata;
      }

      // Create a stream generator for file parts
      const stream = fileHandler.streamFileParts(payload.fileId);

      return {
        response: {
          fileId: payload.fileId,
          allowed: true,
          filename: fileMetadata.filename,
          size: fileMetadata.size,
          mimeType: fileMetadata.mimeType,
          lastModified: fileMetadata.lastModified,
          encrypted: fileMetadata.encrypted,
        },
        stream,
      };
    } catch (error) {
      return {
        response: {
          type: "error",
          statusCode: 500,
          details:
            error instanceof Error
              ? error.message
              : "Failed to get file metadata",
        },
      };
    }
  };
}

// ============================================================================
// Public API
// ============================================================================

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
  const logger = getLogger(["teleportal", "protocols", "file"]);

  return {
    fileUpload: {
      handler: createUploadHandler(fileHandler, options),
      streamHandler: createUploadStreamHandler(fileHandler),
      init: (server) => {
        logger.debug("File upload handler initialized");

        // Set up periodic cleanup of expired uploads
        const cleanupInterval = setInterval(
          async () => {
            try {
              await fileHandler.cleanupExpiredUploads();
            } catch (error) {
              logger.error("Failed to cleanup expired uploads", {
                error: toErrorDetails(error),
              });
            }
          },
          5 * 60 * 1000,
        ); // Every 5 minutes

        return () => {
          clearInterval(cleanupInterval);
          logger.debug("File upload handler cleanup");
        };
      },
    } as RpcServerRequestHandler<unknown, unknown, unknown, RpcServerContext>,
    fileDownload: {
      handler: createDownloadHandler(fileHandler, options),
    } as RpcServerRequestHandler<unknown, unknown, unknown, RpcServerContext>,
  };
}
