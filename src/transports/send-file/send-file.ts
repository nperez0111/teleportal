import { fromBase64 } from "lib0/buffer";
import { compose, withLogger } from "..";
import type { ClientContext, Transport } from "../../lib";
import {
  CHUNK_SIZE,
  verifyMerkleProof,
} from "../../lib/merkle-tree/merkle-tree";
import {
  DecodedFilePart,
  FileTransferProtocol,
  type Message,
} from "../../lib/protocol";

class SendFileClient<
  Context extends ClientContext,
> extends FileTransferProtocol.Client<Context> {
  // Expose protected members for the transport return type
  public activeUploads = new Map<string, FileTransferProtocol.UploadState>();
  public activeDownloads = new Map<
    string,
    FileTransferProtocol.DownloadState
  >();

  private downloadCache = new Map<string, File>();

  constructor(
    private writer: (message: Message<Context>) => Promise<void>,
    private context: Context,
  ) {
    super();
  }

  sendMessage(message: Message<Context>): void {
    // Fire-and-forget the async writer, but handle errors to prevent unhandled rejections
    this.writer(message).catch((error) => {
      // Log error but don't throw - sendMessage is expected to be fire-and-forget
      console.error("[SendFileClient] Error sending message:", error);
    });
  }

  onDownloadComplete(
    state: FileTransferProtocol.DownloadState,
    file: File,
  ): void | Promise<void> {
    this.downloadCache.set(state.fileId, file);
  }

  protected async onUploadReady(fileId: string, file: File): Promise<void> {
    const uploadState = this.activeUploads.get(fileId);
    if (uploadState) {
      await this.processFileUpload(uploadState, this.context);
    }
  }

  protected verifyChunk(chunk: DecodedFilePart, fileId: string): boolean {
    return verifyMerkleProof(
      chunk.chunkData,
      chunk.merkleProof,
      fromBase64(fileId),
      chunk.chunkIndex,
    );
  }

  public checkIncompleteDownloads() {
    for (const [fileId, handler] of this.activeDownloads.entries()) {
      if (
        handler.fileMetadata &&
        handler.chunks.size < Math.ceil(handler.fileMetadata.size / CHUNK_SIZE)
      ) {
        handler.reject(
          new Error(
            `Download incomplete: received ${handler.chunks.size}/${Math.ceil(handler.fileMetadata.size / CHUNK_SIZE)} chunks`,
          ),
        );
        this.activeDownloads.delete(fileId);
      }
    }
  }

  public requestDownload(
    fileId: string,
    document: string,
    encrypted?: boolean,
    timeout?: number,
    context?: Context | undefined,
  ): Promise<File> {
    const file = this.downloadCache.get(fileId);
    if (file) {
      return Promise.resolve(file);
    }

    return super.requestDownload(fileId, document, encrypted, timeout, context);
  }
}

export function withSendFile<
  T extends Transport<Context, Record<string, unknown>>,
  Context extends ClientContext,
>({
  transport,
  context = {} as Context,
}: {
  transport: T;
  context?: Context;
}): Transport<
  Context,
  (T extends Transport<Context, infer I> ? I : {}) &
    FileTransportMethods & {
      activeUploads: Map<string, FileTransferProtocol.UploadState>;
      activeDownloads: Map<string, FileTransferProtocol.DownloadState>;
    }
> {
  let clientWriter: (message: Message<Context>) => Promise<void> = async () => {
    throw new Error("Writer not initialized");
  };
  let serverWriter: (message: Message<Context>) => Promise<void> = async () => {
    throw new Error("Writer not initialized");
  };

  const client = new SendFileClient<Context>(
    (msg) => clientWriter(msg),
    context,
  );
  const sinkTransformStream = new TransformStream<
    Message<Context>,
    Message<Context>
  >({
    start(controller) {
      serverWriter = async (message) => {
        controller.enqueue(message);
      };
    },
    async transform(chunk, controller) {
      const handled = await client.handleMessage(chunk);
      if (!handled) {
        controller.enqueue(chunk);
      }
    },
    flush() {
      client.checkIncompleteDownloads();
    },
  });

  const sourceTransformStream = new TransformStream({
    start(controller) {
      clientWriter = async (message) => {
        // Enqueue to sourceTransformStream so messages appear in readable (for test pattern)
        controller.enqueue(message);
      };
    },
    transform(chunk, controller) {
      controller.enqueue(chunk);
    },
  });

  sinkTransformStream.readable.pipeTo(transport.writable).catch(() => {
    console.error("Error piping sink to transport");
  });

  const wrappedTransport = compose(
    {
      readable: transport.readable.pipeThrough(sourceTransformStream),
    },
    {
      writable: sinkTransformStream.writable,
    },
  ) as any;

  return {
    ...transport,
    ...wrappedTransport,
    activeUploads: client.activeUploads,
    activeDownloads: client.activeDownloads,
    upload: client.requestUpload.bind(client),
    download: client.requestDownload.bind(client),
  };
}

export type FileTransportMethods = {
  /**
   * Upload a file in chunks with merkle tree verification.
   *
   * @returns A promise that resolves to the `fileId` of the uploaded file. This can be used to download the file later using {@link FileTransportMethods.download}.
   */
  upload: (
    /**
     * The file to upload
     */
    file: File,
    /**
     * The document ID to associate the file with
     */
    document: string,
    /**
     * The fileId of the file, this is a client-generated UUID for this upload.
     * @default a random UUID
     */
    fileId?: string,
    /**
     * Whether to encrypt the file.
     * @default false
     */
    encrypted?: boolean,
  ) => Promise<string>;
  /**
   * Download a file by `fileId` returned from {@link FileTransportMethods.upload}.
   * @returns The downloaded file
   */
  download: (
    /**
     * The `fileId` of the file to download. This is the `fileId` returned from {@link FileTransportMethods.upload}.
     */
    fileId: string,
    /**
     * The document ID associated with the file
     */
    document: string,
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
