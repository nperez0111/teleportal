import type { Message, ServerContext } from "teleportal";
import type { FileStorage, TemporaryUploadStorage } from "teleportal/storage";
import { getLogger, Logger } from "@logtape/logtape";
import {
  AckMessage,
  FileMessage,
  FileTransferProtocol,
} from "teleportal/protocol";
import type {
  DecodedFileDownload,
  DecodedFilePart,
  DecodedFileUpload,
} from "../lib/protocol/types";
import { buildMerkleTree, generateMerkleProof } from "teleportal/merkle-tree";
import { toErrorDetails } from "../logging";

/**
 * Maximum file size in bytes (1GB)
 */
const MAX_FILE_SIZE = 1024 * 1024 * 1024;

/**
 * Handle file-related messages.
 */
export class FileHandler<
  Context extends ServerContext,
> extends FileTransferProtocol.Server<Context> {
  #fileStorage: FileStorage;
  #temporaryUploadStorage: TemporaryUploadStorage | undefined;
  #logger: Logger;

  constructor(fileStorage: FileStorage) {
    super();
    this.#fileStorage = fileStorage;
    this.#temporaryUploadStorage = fileStorage.temporaryUploadStorage;
    this.#logger = getLogger(["teleportal", "server", "file-handler"]);
  }

  /**
   * Handle a file message.
   *
   * @param message - The file message to handle
   * @param sendResponse - Function to send a response message
   */
  async handle(
    message: Message<Context>,
    sendResponse: (message: Message<Context>) => Promise<void>,
  ): Promise<void> {
    return this.handleMessage(message, sendResponse);
  }

  protected async checkUploadPermission(
    metadata: DecodedFileUpload,
    context: Context,
  ): Promise<{ allowed: boolean; reason?: string }> {
    if (metadata.size > MAX_FILE_SIZE) {
      return {
        allowed: false,
        reason: `File size ${metadata.size} exceeds maximum ${MAX_FILE_SIZE} bytes`,
      };
    }
    return { allowed: true };
  }

  protected async onUploadStart(
    metadata: DecodedFileUpload,
    context: Context,
    document: string,
    encrypted: boolean,
  ): Promise<void> {
    if (!this.#temporaryUploadStorage) {
      throw new Error(
        "File uploads are not enabled: missing fileStorage.temporaryUploadStorage",
      );
    }

    await this.#temporaryUploadStorage.beginUpload(metadata.fileId, {
      filename: metadata.filename,
      size: metadata.size,
      mimeType: metadata.mimeType,
      encrypted,
      lastModified: Date.now(),
      documentId: document,
    });

    this.#logger
      .with({ uploadId: metadata.fileId })
      .debug("Upload session initiated");
  }

  protected async onDownloadRequest(
    payload: DecodedFileDownload,
    context: Context,
    document: string,
    encrypted: boolean,
    sendMessage: (message: Message<Context>) => Promise<void>,
  ): Promise<void> {
    const log = this.#logger.with({
      fileId: payload.fileId,
      direction: "download",
    });

    try {
      const file = await this.#fileStorage.getFile(payload.fileId);
      if (!file) {
        log.info("File not found for download", {
          fileId: payload.fileId,
        });
        await sendMessage(
          new FileMessage(
            document,
            {
              type: "file-auth-message",
              fileId: payload.fileId,
              permission: "denied",
              reason: "File not found",
              statusCode: 404,
            },
            context,
            encrypted,
          ),
        );
        return;
      }

      log.debug("File found for download", {
        fileId: payload.fileId,
        filename: file.metadata.filename,
      });

      await sendMessage(
        new FileMessage(
          document,
          {
            type: "file-upload",
            fileId: file.id,
            filename: file.metadata.filename,
            size: file.metadata.size,
            mimeType: file.metadata.mimeType,
            lastModified: file.metadata.lastModified,
            encrypted: file.metadata.encrypted,
          },
          context,
          encrypted,
        ),
      );

      const chunks = file.chunks;
      const merkleTree = buildMerkleTree(chunks);
      let bytesSent = 0;

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const proof = generateMerkleProof(merkleTree, i);
        bytesSent += chunk.length;

        await sendMessage(
          new FileMessage(
            document,
            {
              type: "file-part",
              fileId: file.id,
              chunkIndex: i,
              chunkData: chunk,
              merkleProof: proof,
              totalChunks: chunks.length,
              bytesUploaded: bytesSent,
              encrypted: file.metadata.encrypted,
            } as DecodedFilePart,
            context,
            encrypted,
          ),
        );
      }
    } catch (error) {
      log.error("Failed to handle download request", {
        fileId: payload.fileId,
        error: toErrorDetails(error),
      });
      throw error;
    }
  }

  protected async onChunkReceived(
    payload: DecodedFilePart,
    messageId: string,
    document: string,
    context: Context,
    sendMessage: (message: Message<Context>) => Promise<void>,
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

      // Send an ACK for each file-part message that was received
      await sendMessage(
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
            payload.fileId,
          );
          log.debug("Upload completed successfully", {
            uploadId: payload.fileId,
            fileId: result.fileId,
          });

          // Move file from temporary storage to durable storage incrementally
          await this.#fileStorage.storeFileFromUpload(result);
          log.debug("File moved to durable storage", {
            fileId: result.fileId,
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
   * Clean up expired uploads.
   */
  async cleanupExpiredUploads(): Promise<void> {
    if (!this.#temporaryUploadStorage) return;
    await this.#temporaryUploadStorage.cleanupExpiredUploads();
  }
}
