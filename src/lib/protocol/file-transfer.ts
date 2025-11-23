import { toBase64 } from "lib0/buffer";
import { uuidv4 } from "lib0/random";
import {
  buildMerkleTree,
  CHUNK_SIZE,
  generateMerkleProof,
} from "teleportal/merkle-tree";
import { AckMessage, FileMessage, type Message } from "./message-types";
import type {
  DecodedFileAuthMessage,
  DecodedFileDownload,
  DecodedFilePart,
  DecodedFileUpload,
} from "./types";

export namespace FileTransferProtocol {
  export interface UploadState {
    resolve: (fileId: string) => void;
    reject: (error: Error) => void;
    uploadId: string;
    file: File;
    fileId: string | null;
    sentChunks: Set<string>;
    document: string;
  }

  export interface DownloadState {
    resolve: (file: File) => void;
    reject: (error: Error) => void;
    fileMetadata: DecodedFileUpload | null;
    chunks: Map<number, Uint8Array>;
    fileId: string;
    timeoutId: ReturnType<typeof setTimeout> | null;
  }

  export abstract class Client<Context extends Record<string, unknown> = any> {
    protected activeUploads = new Map<string, UploadState>();
    protected activeDownloads = new Map<string, DownloadState>();

    abstract sendMessage(message: Message<Context>): void;

    async requestUpload(
      file: File,
      document: string,
      fileId: string = uuidv4(),
      encrypted: boolean = false,
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
        });
      });

      this.sendMessage(
        new FileMessage<Context>(
          document,
          {
            type: "file-upload",
            fileId,
            filename: file.name,
            size: file.size,
            mimeType: file.type || "application/octet-stream",
            lastModified: file.lastModified,
            encrypted,
          },
          context,
          encrypted,
        ),
      );

      return uploadPromise;
    }

    async requestDownload(
      fileId: string,
      document: string,
      encrypted: boolean = false,
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
        });
      });

      this.sendMessage(
        new FileMessage<Context>(
          document,
          {
            type: "file-download",
            fileId,
          },
          context,
          encrypted,
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

      if (message.type !== "file") {
        return false;
      }

      const fileMessage = message as FileMessage<Context>;

      switch (fileMessage.payload.type) {
        case "file-upload":
          this.handleUploadRequest(
            fileMessage.payload as DecodedFileUpload,
            fileMessage.context,
          );
          break;
        case "file-download":
          await this.handleDownloadRequest(
            fileMessage.payload as DecodedFileDownload,
          );
          break;
        case "file-auth-message":
          this.handleAuthMessage(fileMessage.payload as DecodedFileAuthMessage);
          break;
        case "file-part":
          await this.handleFilePart(
            fileMessage.payload as DecodedFilePart,
            fileMessage.context,
          );
          break;
      }

      return true;
    }

    protected handleAck(message: AckMessage<Context>) {
      let resolved = false;
      this.activeUploads.forEach((handler) => {
        if (handler.sentChunks.delete(message.payload.messageId)) {
          resolved = true;
          if (handler.sentChunks.size === 0) {
            handler.resolve(handler.fileId!);
            this.activeUploads.delete(handler.uploadId);
          }
        }
      });
      return resolved;
    }

    protected handleUploadRequest(
      payload: DecodedFileUpload,
      context?: Context,
    ) {
      // Server sending a file to us (part of download)
      const downloadHandler = this.activeDownloads.get(payload.fileId);
      if (downloadHandler) {
        downloadHandler.fileMetadata = payload;
      }
    }

    protected async handleDownloadRequest(payload: DecodedFileDownload) {
      // Server authorized our upload, start sending chunks
      const activeUpload = this.activeUploads.get(payload.fileId);
      if (!activeUpload) {
        return;
      }

      await this.processFileUpload(activeUpload);
    }

    protected async processFileUpload(
      uploadState: UploadState,
      context?: Context,
    ) {
      // Read file into memory
      const fileBytes = new Uint8Array(await uploadState.file.arrayBuffer());

      // Encrypt if needed (file-level encryption before chunking)
      // TODO: Implement encryption if encrypted flag is set

      // Split into 64KB chunks
      const fileParts: Uint8Array[] = [];
      for (let i = 0; i < fileBytes.length; i += CHUNK_SIZE) {
        fileParts.push(fileBytes.slice(i, i + CHUNK_SIZE));
      }

      // Handle empty files: ensure at least one chunk (even if empty)
      if (fileParts.length === 0) {
        fileParts.push(new Uint8Array(0));
      }

      // Build merkle tree
      const merkleTree = buildMerkleTree(fileParts);
      const contentId = merkleTree.nodes[merkleTree.nodes.length - 1].hash;
      uploadState.fileId = toBase64(contentId);

      // Send chunks with merkle proofs
      let bytesUploaded = 0;
      for (let i = 0; i < fileParts.length; i++) {
        const filePart = fileParts[i];
        const proof = generateMerkleProof(merkleTree, i);
        const message = new FileMessage<Context>(
          uploadState.document,
          {
            type: "file-part",
            fileId: uploadState.uploadId,
            chunkIndex: i,
            chunkData: filePart,
            merkleProof: proof,
            totalChunks: fileParts.length,
            bytesUploaded: bytesUploaded + filePart.length,
            encrypted: false,
            // TODO: Implement encryption if encrypted flag is set
          },
          context ?? ({} as Context),
          false,
        );

        uploadState.sentChunks.add(message.id);
        this.sendMessage(message);
        bytesUploaded += filePart.length;
      }
      new ReadableStream({
        pull: async (controller) => {},
      });
    }

    protected handleAuthMessage(payload: DecodedFileAuthMessage) {
      if (this.activeUploads.has(payload.fileId)) {
        this.activeUploads
          .get(payload.fileId)
          ?.reject(new Error(payload.reason || "Upload permission denied"));
        this.activeUploads.delete(payload.fileId);
      }
      if (this.activeDownloads.has(payload.fileId)) {
        this.activeDownloads
          .get(payload.fileId)
          ?.reject(new Error(payload.reason || "Download permission denied"));
        this.activeDownloads.delete(payload.fileId);
      }
    }

    protected abstract verifyChunk(
      chunk: DecodedFilePart,
      fileId: string,
    ): boolean;

    protected async handleFilePart(
      payload: DecodedFilePart,
      context?: Context,
    ) {
      const handler = this.activeDownloads.get(payload.fileId);
      if (!handler) {
        return;
      }

      // Verify chunk
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

      // Store chunk
      if (!handler.chunks.has(payload.chunkIndex)) {
        handler.chunks.set(payload.chunkIndex, payload.chunkData);
        // Check completion
        await this.checkDownloadCompletion(handler);
      }
    }

    private async checkDownloadCompletion(handler: DownloadState) {
      if (!handler.fileMetadata) {
        return;
      }
      // For empty files, we still need at least one chunk (even if empty)
      const expectedChunks =
        handler.fileMetadata.size === 0
          ? 1
          : Math.ceil(handler.fileMetadata.size / CHUNK_SIZE);
      if (handler.chunks.size >= expectedChunks) {
        try {
          const fileData = new Uint8Array(handler.fileMetadata.size);
          let offset = 0;
          for (let i = 0; i < expectedChunks; i++) {
            const chunk = handler.chunks.get(i);
            if (!chunk) {
              throw new Error(`Missing chunk ${i}`);
            }
            fileData.set(chunk, offset);
            offset += chunk.length;
          }
          const file = new File([fileData], handler.fileMetadata.filename, {
            type: handler.fileMetadata.mimeType,
          });
          await this.onDownloadComplete(handler, file);
          handler.resolve(file);
        } catch (e) {
          handler.reject(e as Error);
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
      if (message.type !== "file") {
        throw new Error("ServerFileHandler can only handle file messages");
      }

      const fileMessage = message as FileMessage<Context>;
      const document = fileMessage.document;

      switch (fileMessage.payload.type) {
        case "file-download":
          await this.onDownloadRequest(
            fileMessage.payload as DecodedFileDownload,
            fileMessage.context,
            document,
            fileMessage.encrypted,
            sendMessage,
          );
          break;
        case "file-upload":
          await this.handleUploadRequest(
            fileMessage.payload as DecodedFileUpload,
            fileMessage.context,
            document,
            fileMessage.encrypted,
            sendMessage,
          );
          break;
        case "file-part":
          await this.onChunkReceived(
            fileMessage.payload as DecodedFilePart,
            message.id,
            document,
            fileMessage.context,
            sendMessage,
          );
          break;
        default:
          // Ignore other types or handle error
          break;
      }
    }

    protected async handleUploadRequest(
      payload: DecodedFileUpload,
      context: Context,
      document: string,
      encrypted: boolean,
      sendMessage: (message: Message<Context>) => Promise<void>,
    ) {
      const allowed = await this.checkUploadPermission(payload, context);
      if (!allowed.allowed) {
        await sendMessage(
          new FileMessage(
            document,
            {
              type: "file-auth-message",
              permission: "denied",
              fileId: payload.fileId,
              reason: allowed.reason,
              statusCode: 403,
            },
            context,
            encrypted,
          ),
        );
        return;
      }

      try {
        await this.onUploadStart(payload, context, document, encrypted);
        await sendMessage(
          new FileMessage(
            document,
            {
              type: "file-download",
              fileId: payload.fileId,
            },
            context,
            encrypted,
          ),
        );
      } catch (error) {
        await sendMessage(
          new FileMessage(
            document,
            {
              type: "file-auth-message",
              permission: "denied",
              fileId: payload.fileId,
              reason: (error as Error).message,
              statusCode: 500,
            },
            context,
            encrypted,
          ),
        );
      }
    }

    protected abstract checkUploadPermission(
      metadata: DecodedFileUpload,
      context: Context,
    ): Promise<{ allowed: boolean; reason?: string }>;

    protected abstract onUploadStart(
      metadata: DecodedFileUpload,
      context: Context,
      document: string,
      encrypted: boolean,
    ): Promise<void>;

    protected abstract onChunkReceived(
      payload: DecodedFilePart,
      messageId: string,
      document: string,
      context: Context,
      sendMessage: (message: Message<Context>) => Promise<void>,
    ): Promise<void>;

    protected abstract onDownloadRequest(
      payload: DecodedFileDownload,
      context: Context,
      document: string,
      encrypted: boolean,
      sendMessage: (message: Message<Context>) => Promise<void>,
    ): Promise<void>;
  }
}
