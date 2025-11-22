import type { Message, ServerContext } from "teleportal";
import type { FileStorage } from "../storage/file-storage";
import type { Logger } from "./logger";
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
import { fromBase64, toBase64 } from "lib0/buffer";

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
  #logger: Logger;

  constructor(fileStorage: FileStorage, logger: Logger) {
    super();
    this.#fileStorage = fileStorage;
    this.#logger = logger.child().withContext({ name: "file-handler" });
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
    // Validate file size
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
    encrypted: boolean,
  ): Promise<void> {
    await this.#fileStorage.initiateUpload(metadata.fileId, {
      filename: metadata.filename,
      size: metadata.size,
      mimeType: metadata.mimeType,
      encrypted,
      lastModified: Date.now(),
    });
    this.#logger
      .child()
      .withContext({ uploadId: metadata.fileId })
      .debug("Upload session initiated");
  }

  protected async onDownloadRequest(
    payload: DecodedFileDownload,
    context: Context,
    encrypted: boolean,
    sendMessage: (message: Message<Context>) => Promise<void>,
  ): Promise<void> {
    const log = this.#logger.child().withContext({
      fileId: payload.fileId,
      direction: "download",
    });

    try {
      // Convert fileId (base64 string) to Uint8Array for file lookup
      const contentId = fromBase64(payload.fileId);
      const file = await this.#fileStorage.getFile(contentId);
      if (!file) {
        log
          .withMetadata({ fileId: payload.fileId })
          .info("File not found for download");
        await sendMessage(
          new FileMessage(
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

      log
        .withMetadata({
          fileId: payload.fileId,
          filename: file.metadata.filename,
        })
        .debug("File found for download");

      // Send upload initiation response
      await sendMessage(
        new FileMessage(
          {
            type: "file-upload",
            fileId: toBase64(contentId),
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

      // Then stream file chunks with merkle proofs as file-part messages
      const chunks = file.chunks;
      const merkleTree = buildMerkleTree(chunks);
      let bytesSent = 0;

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const proof = generateMerkleProof(merkleTree, i);
        bytesSent += chunk.length;

        await sendMessage(
          new FileMessage(
            {
              type: "file-part",
              fileId: toBase64(contentId),
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
      log
        .withError(error as Error)
        .withMetadata({ fileId: payload.fileId })
        .error("Failed to handle download request");
      throw error;
    }
  }

  protected async onChunkReceived(
    payload: DecodedFilePart,
    messageId: string,
    context: Context,
    sendMessage: (message: Message<Context>) => Promise<void>,
  ): Promise<void> {
    const log = this.#logger.child().withMetadata({
      fileId: payload.fileId,
      chunkIndex: payload.chunkIndex,
      totalChunks: payload.totalChunks,
      bytesUploaded: payload.bytesUploaded,
    });

    log.debug("Handling file progress");

    // Get upload progress
    const upload = await this.#fileStorage.getUploadProgress(payload.fileId);
    if (!upload) {
      const error = new Error(`Upload session ${payload.fileId} not found`);
      log.withError(error).error("Upload session not found");
      throw error;
    }

    try {
      // Send an ACK for each file-part message that was received
      await sendMessage(
        new AckMessage({
          type: "ack",
          messageId,
        }),
      );
      // Store the chunk
      await this.#fileStorage.storeChunk(
        payload.fileId,
        payload.chunkIndex,
        payload.chunkData,
        payload.merkleProof,
      );

      // Get updated upload progress
      const updatedUpload = await this.#fileStorage.getUploadProgress(
        payload.fileId,
      );
      if (!updatedUpload) {
        throw new Error(
          `Upload session ${payload.fileId} not found after storing chunk`,
        );
      }

      // Check if upload is complete
      // Handle empty files: ensure at least one chunk
      const totalChunks =
        updatedUpload.metadata.size === 0
          ? 1
          : Math.ceil(updatedUpload.metadata.size / (64 * 1024));
      if (updatedUpload.chunks.size >= totalChunks) {
        // All chunks received - build merkle tree and complete upload
        const chunks: Uint8Array[] = [];
        for (let i = 0; i < totalChunks; i++) {
          const chunk = updatedUpload.chunks.get(i);
          if (!chunk) {
            // Not all chunks received yet
            break;
          }
          chunks.push(chunk);
        }

        if (chunks.length === totalChunks) {
          // All chunks present, build tree and complete
          const merkleTree = buildMerkleTree(chunks);
          const contentId = merkleTree.nodes[merkleTree.nodes.length - 1].hash;

          try {
            await this.#fileStorage.completeUpload(payload.fileId, contentId);
            log
              .withMetadata({
                fileId: payload.fileId,
                contentId: toBase64(contentId),
              })
              .debug("Upload completed successfully");
          } catch (error) {
            log
              .withError(error as Error)
              .withMetadata({ fileId: payload.fileId })
              .error("Failed to complete upload");
            throw error;
          }
        }
      }

      log.debug("Chunk stored successfully");
    } catch (error) {
      log
        .withError(error as Error)
        .withMetadata({
          fileId: payload.fileId,
          chunkIndex: payload.chunkIndex,
        })
        .error("Failed to store chunk");
      throw error;
    }
  }

  /**
   * Clean up expired uploads.
   */
  async cleanupExpiredUploads(): Promise<void> {
    await this.#fileStorage.cleanupExpiredUploads();
  }
}
