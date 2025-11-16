import { toBase64 } from "lib0/buffer";
import {
  deserializeMerkleTree,
  FileMessage,
  FILE_CHUNK_SIZE,
  generateMerkleProof,
} from "teleportal/protocol";
import type { ServerContext } from "teleportal";
import type { FileData, FileStorage } from "teleportal/storage";
import type { Client } from "./client";
import type { Logger } from "./logger";

const MAX_FILE_SIZE_BYTES = 1_073_741_824; // 1 GiB

export class FileTransferHandler<Context extends ServerContext> {
  #storage: FileStorage;
  #logger: Logger;
  #maxSize: number;

  constructor(args: {
    storage: FileStorage;
    logger: Logger;
    maxSizeBytes?: number;
  }) {
    this.#storage = args.storage;
    this.#logger = args.logger.child().withContext({ name: "file-handler" });
    this.#maxSize = args.maxSizeBytes ?? MAX_FILE_SIZE_BYTES;
  }

  async handle(message: FileMessage<Context>, client: Client<Context>) {
    const payload = message.payload;
    switch (payload.type) {
      case "file-request":
        return this.#handleRequest(message, client);
      case "file-progress":
        return this.#handleProgress(message, client);
      default:
        this.#logger
          .withMetadata({
            payloadType: payload.type,
            clientId: client.id,
          })
          .warn("Unknown file payload type");
    }
  }

  async #handleRequest(message: FileMessage<Context>, client: Client<Context>) {
    const payload = message.payload;
    if (payload.direction === "upload") {
      await this.#handleUploadRequest(message, client);
      return;
    }
    await this.#handleDownloadRequest(message, client);
  }

  async #handleUploadRequest(
    message: FileMessage<Context>,
    client: Client<Context>,
  ) {
    const payload = message.payload;
    if (payload.size > this.#maxSize) {
      await this.#rejectUpload(
        payload,
        client,
        "File exceeds maximum supported size",
        message,
      );
      return;
    }
    if (!payload.contentId) {
      await this.#rejectUpload(
        payload,
        client,
        "contentId is required for uploads",
        message,
      );
      return;
    }

    const totalChunks = Math.max(
      1,
      Math.ceil(payload.size / FILE_CHUNK_SIZE),
    );

    let progress = await this.#storage.getUploadProgress(payload.fileId);
    if (!progress) {
      await this.#storage.initiateUpload(payload.fileId, {
        fileId: payload.fileId,
        filename: payload.filename,
        size: payload.size,
        mimeType: payload.mimeType,
        totalChunks,
        encrypted: payload.encrypted ?? message.encrypted ?? false,
        contentId: payload.contentId,
        initiatedBy: message.context.userId,
      });
      progress = await this.#storage.getUploadProgress(payload.fileId);
    } else if (
      progress.contentId &&
      payload.contentId &&
      toBase64(progress.contentId) !== toBase64(payload.contentId)
    ) {
      await this.#rejectUpload(
        payload,
        client,
        "Upload session already exists for a different contentId",
        message,
      );
      return;
    }

    await client.send(
      new FileMessage(
        {
          ...payload,
          contentId: payload.contentId,
          status: "accepted",
          resumeFromChunk: progress?.chunksReceived ?? 0,
          bytesUploaded: progress?.bytesUploaded ?? 0,
        },
        message.context,
        message.encrypted,
      ),
    );
  }

  async #handleDownloadRequest(
    message: FileMessage<Context>,
    client: Client<Context>,
  ) {
    const payload = message.payload;
    if (!payload.contentId) {
      await this.#rejectUpload(
        payload,
        client,
        "contentId is required for downloads",
        message,
      );
      return;
    }

    const contentKey = toBase64(payload.contentId);
    const file = await this.#storage.getFile(contentKey);
    if (!file) {
      await this.#rejectUpload(
        payload,
        client,
        "File not found for requested contentId",
        message,
      );
      return;
    }

    await client.send(
      new FileMessage(
        {
          type: "file-request",
          direction: "download",
          fileId: payload.fileId,
          filename: file.metadata.filename,
          size: file.metadata.size,
          mimeType: file.metadata.mimeType,
          contentId: payload.contentId,
          status: "accepted",
          resumeFromChunk: file.metadata.totalChunks,
          bytesUploaded: file.metadata.size,
          encrypted: file.metadata.encrypted,
        },
        message.context,
        message.encrypted,
      ),
    );

    await this.#streamDownload(file, message, client);
  }

  async #handleProgress(
    message: FileMessage<Context>,
    client: Client<Context>,
  ) {
    const payload = message.payload;
    const log = this.#logger.child().withContext({
      fileId: payload.fileId,
      chunkIndex: payload.chunkIndex,
    });

    try {
      await this.#storage.storeChunk(
        payload.fileId,
        payload.chunkIndex,
        payload.chunkData,
        payload.merkleProof,
      );
      const progress = await this.#storage.getUploadProgress(payload.fileId);
      if (
        progress &&
        progress.chunksReceived === progress.totalChunks &&
        progress.contentId
      ) {
        const contentId = await this.#storage.completeUpload(payload.fileId);
        const stored = await this.#storage.getFile(toBase64(contentId));
        await client.send(
          new FileMessage(
            {
              type: "file-request",
              direction: "upload",
              fileId: payload.fileId,
              filename: stored?.metadata.filename ?? "",
              size: stored?.metadata.size ?? progress.bytesUploaded,
              mimeType: stored?.metadata.mimeType ?? "",
              contentId,
              status: "accepted",
              resumeFromChunk: progress.totalChunks,
              bytesUploaded: progress.bytesUploaded,
            },
            message.context,
            message.encrypted,
          ),
        );
      }
    } catch (error) {
      log.withError(error as Error).error("Failed to store file chunk");
      await this.#rejectUpload(
        {
          type: "file-request",
          direction: "upload",
          fileId: payload.fileId,
          filename: "",
          size: payload.bytesUploaded,
          mimeType: "",
          contentId: undefined,
        },
        client,
        (error as Error).message,
        message,
      );
    }
  }

  async #streamDownload(
    file: FileData,
    message: FileMessage<Context>,
    client: Client<Context>,
  ) {
    const tree = deserializeMerkleTree(
      file.merkleTree,
      file.metadata.totalChunks,
    );
    for (let i = 0; i < file.metadata.totalChunks; i++) {
      const chunk = file.chunks[i];
      const proof = generateMerkleProof(tree, i);
      await client.send(
        new FileMessage(
          {
            type: "file-progress",
            fileId: message.payload.fileId,
            chunkIndex: i,
            chunkData: chunk,
            merkleProof: proof,
            totalChunks: file.metadata.totalChunks,
            bytesUploaded: chunk.length * (i + 1),
            encrypted: file.metadata.encrypted,
          },
          message.context,
          message.encrypted,
        ),
      );
    }
  }

  async #rejectUpload(
    payload: {
      fileId: string;
      filename: string;
      size: number;
      mimeType: string;
      direction: "upload" | "download";
      contentId?: Uint8Array;
    },
    client: Client<Context>,
    reason: string,
    message: FileMessage<Context>,
  ) {
    await client.send(
      new FileMessage(
        {
          ...payload,
          status: "rejected",
          reason,
        },
        message.context,
        message.encrypted,
      ),
    );
  }
}
