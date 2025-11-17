import type {
  ClientContext,
  Message,
  Source,
  Sink,
  Transport,
} from "teleportal";
import { FileMessage } from "teleportal/protocol";
import type {
  DecodedFileProgress,
  DecodedFileRequest,
} from "teleportal/protocol";
import { Observable } from "teleportal";
import { compose } from "teleportal/transports";
import {
  buildMerkleTree,
  CHUNK_SIZE,
  generateMerkleProof,
  verifyMerkleProof,
} from "../../lib/merkle-tree/merkle-tree";
import { fromBase64, toBase64 } from "lib0/buffer";

/**
 * Handler for file download operations
 */
interface FileDownloadHandler {
  resolve: (file: File) => void;
  reject: (error: Error) => void;
  fileMetadata: DecodedFileRequest | null;
  chunks: Map<number, Uint8Array>;
  totalChunks: number;
  receivedChunks: number;
  fileId: string;
  timeout: number;
}

/**
 * Handler for file upload operations
 */
interface FileUploadHandler {
  resolve: (fileId: string) => void;
  reject: (error: Error) => void;
  fileId: string;
}

/**
 * Makes a {@link Source} that intercepts file messages for downloads
 */
export function getFileSource<Context extends ClientContext>({
  transport,
  observer = new Observable<{
    message: (message: Message) => void;
  }>(),
  activeDownloads = new Map<string, FileDownloadHandler>(),
}: {
  transport: Transport<Context, any>;
  observer?: Observable<{
    message: (message: Message) => void;
  }>;
  activeDownloads?: Map<string, FileDownloadHandler>;
}): Source<
  Context,
  {
    activeDownloads: Map<string, FileDownloadHandler>;
  }
> {
  const transformStream = new TransformStream({
    transform(value, controller) {
      // Process file messages for active downloads in the background
      // This runs synchronously during transform, so downloads are handled immediately
      if (value.type === "file") {
        const fileMessage = value as FileMessage<Context>;
        let handled = false;

        // Handle file-request response (metadata)
        if (fileMessage.payload.type === "file-request") {
          const payload = fileMessage.payload as DecodedFileRequest;
          if (payload.direction === "download") {
            const handler = activeDownloads.get(payload.fileId);
            if (handler) {
              handler.fileMetadata = payload;
              handler.totalChunks =
                payload.size === 0 ? 1 : Math.ceil(payload.size / CHUNK_SIZE);

              // If file is empty, we're done
              if (handler.totalChunks === 0 || payload.size === 0) {
                handler.chunks.set(0, new Uint8Array(0));
                handler.receivedChunks = 1;
                // Resolve the download
                try {
                  const file = new File([new Uint8Array(0)], payload.filename, {
                    type: payload.mimeType,
                  });
                  handler.resolve(file);
                } catch (e) {
                  handler.reject(e as Error);
                }
                activeDownloads.delete(payload.fileId);
                handled = true;
              } else {
                // Check if we already received all chunks
                if (handler.receivedChunks >= handler.totalChunks) {
                  // Resolve the download
                  try {
                    const fileData = new Uint8Array(payload.size);
                    let offset = 0;
                    for (let i = 0; i < handler.totalChunks; i++) {
                      const chunk = handler.chunks.get(i);
                      if (!chunk) {
                        throw new Error(`Missing chunk ${i}`);
                      }
                      fileData.set(chunk, offset);
                      offset += chunk.length;
                    }
                    const file = new File([fileData], payload.filename, {
                      type: payload.mimeType,
                    });
                    handler.resolve(file);
                  } catch (e) {
                    handler.reject(e as Error);
                  }
                  activeDownloads.delete(payload.fileId);
                  handled = true;
                }
              }
            }
          }
        }

        // Handle file-progress messages (chunks)
        if (fileMessage.payload.type === "file-progress") {
          const payload = fileMessage.payload as DecodedFileProgress;
          const handler = activeDownloads.get(payload.fileId);
          if (handler) {
            // Convert fileId (hex string) to Uint8Array for merkle proof verification
            const contentId = fromBase64(handler.fileId);
            // Verify chunk using merkle proof
            const isValid = verifyMerkleProof(
              payload.chunkData,
              payload.merkleProof,
              contentId,
              payload.chunkIndex,
            );

            if (!isValid) {
              handler.reject(
                new Error(
                  `Chunk ${payload.chunkIndex} failed merkle proof verification`,
                ),
              );
              activeDownloads.delete(payload.fileId);
              handled = true;
            } else {
              // Store chunk
              if (!handler.chunks.has(payload.chunkIndex)) {
                handler.chunks.set(payload.chunkIndex, payload.chunkData);
                handler.receivedChunks++;

                // Check if we've received all chunks (only if we have metadata)
                if (
                  handler.fileMetadata &&
                  handler.receivedChunks >= handler.totalChunks
                ) {
                  // Resolve the download
                  try {
                    const fileData = new Uint8Array(handler.fileMetadata.size);
                    let offset = 0;
                    for (let i = 0; i < handler.totalChunks; i++) {
                      const chunk = handler.chunks.get(i);
                      if (!chunk) {
                        throw new Error(`Missing chunk ${i}`);
                      }
                      fileData.set(chunk, offset);
                      offset += chunk.length;
                    }
                    const file = new File(
                      [fileData],
                      handler.fileMetadata.filename,
                      { type: handler.fileMetadata.mimeType },
                    );
                    handler.resolve(file);
                  } catch (e) {
                    handler.reject(e as Error);
                  }
                  activeDownloads.delete(payload.fileId);
                  handled = true;
                }
              }
            }
          }
        }

        // If we handled the message for a download, don't pass it through
        if (handled) {
          // Still emit to observer but don't enqueue
          observer.call("message", value);
          return;
        }
      }

      // Pass through all messages (including unhandled file messages)
      controller.enqueue(value);

      // Also emit to observer
      observer.call("message", value);
    },
  });

  // Start consuming the stream to ensure TransformStream processes messages
  // This is necessary because TransformStream only processes when something reads from it
  const reader = transport.readable.getReader();
  const writer = transformStream.writable.getWriter();

  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          // Check for incomplete downloads and reject them
          for (const [fileId, handler] of activeDownloads.entries()) {
            if (
              handler.fileMetadata &&
              handler.receivedChunks < handler.totalChunks
            ) {
              handler.reject(
                new Error(
                  `Download incomplete: received ${handler.receivedChunks}/${handler.totalChunks} chunks`,
                ),
              );
              activeDownloads.delete(fileId);
            }
          }
          await writer.close();
          break;
        }
        await writer.write(value);
      }
    } catch (error) {
      // Reject all active downloads on error
      for (const [fileId, handler] of activeDownloads.entries()) {
        handler.reject(error as Error);
        activeDownloads.delete(fileId);
      }
      try {
        await writer.abort(error);
      } catch {
        // Ignore abort errors
      }
    } finally {
      reader.releaseLock();
    }
  })();

  // Also create a readable that discards messages (for compatibility)
  // but the real processing happens in the background consumer above
  const discardReader = transformStream.readable.getReader();
  (async () => {
    try {
      while (true) {
        const { done } = await discardReader.read();
        if (done) break;
        // Discard - messages are already processed by the transform
      }
    } catch {
      // Ignore errors
    } finally {
      discardReader.releaseLock();
    }
  })();

  return {
    activeDownloads,
    readable: transformStream.readable,
  };
}

/**
 * Makes a {@link Sink} that intercepts file messages for uploads
 */
export function getFileSink<Context extends ClientContext>({
  transport,
  observer = new Observable<{
    message: (message: Message) => void;
  }>(),
  activeUploads = new Map<string, FileUploadHandler>(),
}: {
  transport: Transport<Context, any>;
  observer?: Observable<{
    message: (message: Message) => void;
  }>;
  activeUploads?: Map<string, FileUploadHandler>;
}): Sink<
  Context,
  {
    activeUploads: Map<string, FileUploadHandler>;
  }
> {
  return {
    activeUploads,
    writable: new WritableStream({
      async write(chunk, controller) {
        try {
          // Check if this is a file message for an active upload
          if (chunk.type === "file") {
            const fileMessage = chunk as FileMessage<Context>;
            const handler = activeUploads.get(
              (fileMessage.payload as DecodedFileRequest | DecodedFileProgress)
                .fileId,
            );

            // If this is an upload-related message and we have a handler, let it pass through
            // The upload logic will handle sending the messages
            if (
              handler &&
              (fileMessage.payload.type === "file-request" ||
                fileMessage.payload.type === "file-progress")
            ) {
              // Pass through to underlying transport
              const writer = transport.writable.getWriter();
              try {
                await writer.write(chunk);
              } finally {
                writer.releaseLock();
              }
              return;
            }
          }

          // Pass through all other messages
          const writer = transport.writable.getWriter();
          try {
            await writer.write(chunk);
          } finally {
            writer.releaseLock();
          }

          // Emit to observer
          observer.call("message", chunk);
        } catch (e) {
          controller.error(e);
        }
      },
      close: transport.writable.close,
      abort: transport.writable.abort,
    }),
  };
}

export type FileTransportMethods = {
  /**
   * Upload a file in chunks with merkle tree verification.
   *
   * @returns The merkle root hash (hex string) of the uploaded file, which should be used as the fileId for future downloads
   */
  upload: (
    /**
     * The file to upload
     */
    file: File,
    /**
     * The fileId of the file, this is a client-generated UUID for this upload.
     */
    fileId: string,
    /**
     * Whether to encrypt the file.
     * @default false
     */
    encrypted?: boolean,
  ) => Promise<string>;
  /**
   * Download a file by merkle root hash.
   * @returns The downloaded file
   */
  download: (
    /**
     * The merkle root hash (hex string) of the file to download. This is the fileId returned from upload().
     */
    fileId: string,
    /**
     * Whether the file is encrypted.
     * @default false
     */
    encrypted?: boolean,
    /**
     * Timeout in milliseconds for the download
     * @default 60000
     */
    timeout?: number,
  ) => Promise<File>;
};

/**
 * Makes a {@link Transport} that wraps another transport and provides file upload/download methods
 */
export function getFileTransport<Context extends ClientContext>({
  transport,
  context,
}: {
  transport: Transport<Context, any>;
  context: Context;
}): Transport<
  Context,
  {
    activeDownloads: Map<string, FileDownloadHandler>;
    activeUploads: Map<string, FileUploadHandler>;
  } & FileTransportMethods
> {
  const observer = new Observable<{
    message: (message: Message) => void;
  }>();
  const activeDownloads = new Map<string, FileDownloadHandler>();
  const activeUploads = new Map<string, FileUploadHandler>();

  const source = getFileSource<Context>({
    transport,
    observer,
    activeDownloads,
  });

  const sink = getFileSink<Context>({
    transport,
    observer,
    activeUploads,
  });

  const fileTransport = compose(source, sink);

  return {
    ...fileTransport,
    async upload(file, fileId, encrypted = false) {
      // Read file into memory
      const fileData = await file.arrayBuffer();
      const fileBytes = new Uint8Array(fileData);

      // Encrypt if needed (file-level encryption before chunking)
      let dataToUpload = fileBytes;
      // TODO: Implement encryption if encrypted flag is set
      // For now, we'll skip encryption implementation

      // Split into 64KB chunks
      const chunks: Uint8Array[] = [];
      for (let i = 0; i < dataToUpload.length; i += CHUNK_SIZE) {
        chunks.push(dataToUpload.slice(i, i + CHUNK_SIZE));
      }

      // Handle empty files: ensure at least one chunk (even if empty)
      if (chunks.length === 0) {
        chunks.push(new Uint8Array(0));
      }

      // Build merkle tree
      const merkleTree = buildMerkleTree(chunks);
      const contentId = merkleTree.nodes[merkleTree.nodes.length - 1].hash;
      const contentIdKey = toBase64(contentId);

      // Set up upload handler
      const uploadPromise = new Promise<string>((resolve, reject) => {
        activeUploads.set(fileId, {
          resolve,
          reject,
          fileId,
        });
      });

      // Send file request
      const requestMessage = new FileMessage<Context>(
        {
          type: "file-request",
          direction: "upload",
          fileId,
          filename: file.name,
          size: dataToUpload.length,
          mimeType: file.type || "application/octet-stream",
        },
        context,
        encrypted,
      );

      const writer = fileTransport.writable.getWriter();
      try {
        await writer.write(requestMessage);
      } finally {
        writer.releaseLock();
      }

      // Send chunks with merkle proofs
      let bytesUploaded = 0;
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const proof = generateMerkleProof(merkleTree, i);

        const progressMessage = new FileMessage<Context>(
          {
            type: "file-progress",
            fileId,
            chunkIndex: i,
            chunkData: chunk,
            merkleProof: proof,
            totalChunks: chunks.length,
            bytesUploaded: bytesUploaded + chunk.length,
            encrypted,
          },
          context,
          encrypted,
        );

        const chunkWriter = fileTransport.writable.getWriter();
        try {
          await chunkWriter.write(progressMessage);
        } finally {
          chunkWriter.releaseLock();
        }
        bytesUploaded += chunk.length;
      }

      activeUploads.get(fileId)?.resolve(contentIdKey);
      activeUploads.delete(fileId);

      return uploadPromise;
    },
    async download(fileId, encrypted = false, timeout = 60000) {
      // Set up timeout
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          const handler = activeDownloads.get(fileId);
          if (handler) {
            handler.reject(new Error(`Download timeout after ${timeout}ms`));
            activeDownloads.delete(fileId);
          }
          reject(new Error(`Download timeout after ${timeout}ms`));
        }, timeout);
      });

      // Set up download handler
      const downloadPromise = new Promise<File>((resolve, reject) => {
        activeDownloads.set(fileId, {
          resolve,
          reject,
          fileMetadata: null,
          chunks: new Map(),
          totalChunks: 0,
          receivedChunks: 0,
          fileId,
          timeout,
        });
      });

      // Send download request - fileId is the merkle root hash (hex string)
      const requestMessage = new FileMessage<Context>(
        {
          type: "file-request",
          direction: "download",
          fileId,
          filename: "", // Will be filled by server
          size: 0, // Will be filled by server
          mimeType: "", // Will be filled by server
        },
        context,
        encrypted,
      );

      const writer = fileTransport.writable.getWriter();
      try {
        await writer.write(requestMessage);
      } finally {
        writer.releaseLock();
      }

      // Wait for download to complete or timeout
      // The source will resolve the downloadPromise when all chunks are received
      return await Promise.race([downloadPromise, timeoutPromise]);
    },
  };
}
