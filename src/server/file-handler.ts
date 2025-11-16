import type { Message, ServerContext } from "teleportal";
import type { FileStorage } from "../storage/file-storage";
import type { Logger } from "./logger";
import { FileMessage } from "../lib/protocol/message-types";
import type {
  DecodedFileProgress,
  DecodedFileRequest,
} from "../lib/protocol/types";
import { buildMerkleTree } from "teleportal/files";

/**
 * Maximum file size in bytes (1GB)
 */
const MAX_FILE_SIZE = 1024 * 1024 * 1024;

/**
 * Handle file-related messages.
 */
export class FileHandler<Context extends ServerContext> {
  #fileStorage: FileStorage;
  #logger: Logger;

  constructor(fileStorage: FileStorage, logger: Logger) {
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
    sendResponse?: (message: Message<Context>) => Promise<void>,
  ): Promise<void> {
    if (message.type !== "file") {
      throw new Error("FileHandler can only handle file messages");
    }

    const fileMessage = message as FileMessage<Context>;
    const log = this.#logger.child().withContext({
      messageId: message.id,
      fileId: (fileMessage.payload as any).fileId,
    });

    switch (fileMessage.payload.type) {
      case "file-request": {
        await this.#handleFileRequest(
          fileMessage.payload,
          fileMessage.context,
          fileMessage.encrypted,
          sendResponse,
        );
        break;
      }
      case "file-progress": {
        await this.#handleFileProgress(fileMessage.payload, log);
        break;
      }
      default: {
        log
          .withMetadata({
            payloadType: (fileMessage.payload as any).type,
          })
          .error("Unknown file payload type");
        throw new Error(
          `Unknown file payload type: ${(fileMessage.payload as any).type}`,
        );
      }
    }
  }

  /**
   * Handle a file request (upload or download initiation).
   */
  async #handleFileRequest(
    payload: DecodedFileRequest,
    context: Context,
    encrypted: boolean,
    sendResponse?: (message: Message<Context>) => Promise<void>,
  ): Promise<void> {
    const log = this.#logger.child().withContext({
      fileId: payload.fileId,
      direction: payload.direction,
    });

    log
      .withMetadata({
        fileId: payload.fileId,
        filename: payload.filename,
        size: payload.size,
        mimeType: payload.mimeType,
        direction: payload.direction,
      })
      .debug("Handling file request");

    // Validate file size
    if (payload.size > MAX_FILE_SIZE) {
      const error = new Error(
        `File size ${payload.size} exceeds maximum ${MAX_FILE_SIZE}`,
      );
      log
        .withError(error)
        .withMetadata({ size: payload.size, maxSize: MAX_FILE_SIZE })
        .error("File size validation failed");

      if (sendResponse) {
        // Send denial response
        await sendResponse(
          new FileMessage(
            {
              type: "file-request",
              direction: payload.direction,
              fileId: payload.fileId,
              filename: payload.filename,
              size: payload.size,
              mimeType: payload.mimeType,
            },
            context,
            encrypted,
          ),
        );
      }
      throw error;
    }

    if (payload.direction === "upload") {
      // Upload request
      try {
        await this.#fileStorage.initiateUpload(payload.fileId, {
          filename: payload.filename,
          size: payload.size,
          mimeType: payload.mimeType,
          encrypted,
          createdAt: Date.now(),
        });

        log
          .withMetadata({ fileId: payload.fileId })
          .debug("Upload session initiated");

        // Send approval response (could be enhanced with more details)
        if (sendResponse) {
          await sendResponse(
            new FileMessage(
              {
                type: "file-request",
                direction: "upload",
                fileId: payload.fileId,
                filename: payload.filename,
                size: payload.size,
                mimeType: payload.mimeType,
              },
              context,
              encrypted,
            ),
          );
        }
      } catch (error) {
        log
          .withError(error as Error)
          .withMetadata({ fileId: payload.fileId })
          .error("Failed to initiate upload");
        throw error;
      }
    } else {
      // Download request
      if (!payload.contentId) {
        const error = new Error("contentId required for download requests");
        log.withError(error).error("Download request missing contentId");
        throw error;
      }

      try {
        const file = await this.#fileStorage.getFile(payload.contentId);
        if (!file) {
          const error = new Error(
            `File not found for contentId: ${Array.from(payload.contentId)
              .map((b) => b.toString(16).padStart(2, "0"))
              .join("")}`,
          );
          log
            .withError(error)
            .withMetadata({ contentId: payload.contentId })
            .error("File not found for download");
          throw error;
        }

        log
          .withMetadata({
            fileId: payload.fileId,
            contentId: payload.contentId,
            filename: file.metadata.filename,
          })
          .debug("File found for download");

        // Send file data response (could be enhanced to stream chunks)
        // For now, we just acknowledge the request
        if (sendResponse) {
          await sendResponse(
            new FileMessage(
              {
                type: "file-request",
                direction: "download",
                fileId: payload.fileId,
                filename: file.metadata.filename,
                size: file.metadata.size,
                mimeType: file.metadata.mimeType,
                contentId: payload.contentId,
              },
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
  }

  /**
   * Handle file progress (chunk upload).
   */
  async #handleFileProgress(
    payload: DecodedFileProgress,
    log: Logger,
  ): Promise<void> {
    log
      .withMetadata({
        fileId: payload.fileId,
        chunkIndex: payload.chunkIndex,
        totalChunks: payload.totalChunks,
        bytesUploaded: payload.bytesUploaded,
      })
      .debug("Handling file progress");

    // Get upload progress
    const upload = await this.#fileStorage.getUploadProgress(payload.fileId);
    if (!upload) {
      const error = new Error(`Upload session ${payload.fileId} not found`);
      log.withError(error).error("Upload session not found");
      throw error;
    }

    // Verify merkle proof
    // For incremental verification, we need the expected root
    // Since we don't have it yet, we'll verify when completing the upload
    // For now, we'll store the chunk

    // Calculate expected contentId (merkle root) from the tree
    // This would ideally be provided or calculated incrementally
    // For now, we'll verify during completion

    try {
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
      const totalChunks = Math.ceil(updatedUpload.metadata.size / (64 * 1024));
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
                contentId: Array.from(contentId)
                  .map((b) => b.toString(16).padStart(2, "0"))
                  .join(""),
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

      log
        .withMetadata({
          fileId: payload.fileId,
          chunkIndex: payload.chunkIndex,
          progress: `${payload.bytesUploaded}/${upload.metadata.size}`,
        })
        .debug("Chunk stored successfully");
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
