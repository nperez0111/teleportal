import type { Message, Transport } from "../index";
import {
  buildMerkleTree,
  FILE_CHUNK_SIZE,
  generateMerkleProof,
  getMerkleRoot,
  verifyMerkleProof,
} from "./file-upload";
import { FileMessage } from "./message-types";
import type {
  DecodedFileProgress,
  DecodedFileRequest,
} from "./types";
import { encryptUpdate, decryptUpdate } from "teleportal/encryption-key";

type CachedUpload = {
  chunks: Uint8Array[];
  tree: ReturnType<typeof buildMerkleTree>;
  metadata: {
    fileId: string;
    filename: string;
    mimeType: string;
    size: number;
    totalChunks: number;
    contentId: Uint8Array;
    encrypted: boolean;
  };
};

type UploadOptions = {
  filename?: string;
  mimeType?: string;
  encryptionKey?: CryptoKey;
};

type DownloadOptions = {
  encryptionKey?: CryptoKey;
  filename?: string;
  mimeType?: string;
};

/**
 * Utility for streaming file uploads over the Teleportal protocol.
 * Requires a dedicated transport connection for the duration of the upload.
 */
export class FileUploader<Context extends Record<string, unknown>> {
  #uploads = new Map<string, CachedUpload>();

  async upload(
    file: Blob,
    fileId: string,
    transport: Transport<Context>,
    context: Context,
    options?: UploadOptions,
  ): Promise<Uint8Array> {
    const cached = await this.#prepareUpload(file, fileId, options);
    return this.#performUpload(cached, transport, context);
  }

  async resumeUpload(
    fileId: string,
    transport: Transport<Context>,
    context: Context,
  ): Promise<Uint8Array> {
    const cached = this.#uploads.get(fileId);
    if (!cached) {
      throw new Error(`No cached upload found for ${fileId}`);
    }
    return this.#performUpload(cached, transport, context);
  }

  async #performUpload(
    cached: CachedUpload,
    transport: Transport<Context>,
    context: Context,
  ): Promise<Uint8Array> {
    const writer = transport.writable.getWriter();
    const reader = transport.readable.getReader();
    try {
      await writer.ready;
      await writer.write(
        new FileMessage(
          {
            type: "file-request",
            direction: "upload",
            fileId: cached.metadata.fileId,
            filename: cached.metadata.filename,
            size: cached.metadata.size,
            mimeType: cached.metadata.mimeType,
            contentId: cached.metadata.contentId,
            encrypted: cached.metadata.encrypted,
          },
          context,
          cached.metadata.encrypted,
        ),
      );

      const ack = await this.#waitForRequestAck(reader, cached.metadata.fileId);
      if (ack.status === "rejected") {
        throw new Error(ack.reason ?? "Server rejected file upload");
      }

      const startIndex = ack.resumeFromChunk ?? 0;
      for (let i = startIndex; i < cached.metadata.totalChunks; i++) {
        const proof = generateMerkleProof(cached.tree, i);
        await writer.ready;
        await writer.write(
          new FileMessage(
            {
              type: "file-progress",
              fileId: cached.metadata.fileId,
              chunkIndex: i,
              chunkData: cached.chunks[i],
              merkleProof: proof,
              totalChunks: cached.metadata.totalChunks,
              bytesUploaded: Math.min(
                (i + 1) * FILE_CHUNK_SIZE,
                cached.metadata.size,
              ),
              encrypted: cached.metadata.encrypted,
            },
            context,
            cached.metadata.encrypted,
          ),
        );
      }

      const completion = await this.#waitForCompletion(
        reader,
        cached.metadata.fileId,
        cached.metadata.totalChunks,
      );
      if (completion.status === "rejected") {
        throw new Error(completion.reason ?? "Upload failed on server");
      }

      this.#uploads.delete(cached.metadata.fileId);
      return cached.metadata.contentId;
    } finally {
      reader.releaseLock();
      writer.releaseLock();
    }
  }

  async #prepareUpload(
    file: Blob,
    fileId: string,
    options?: UploadOptions,
  ): Promise<CachedUpload> {
    const existing = this.#uploads.get(fileId);
    if (existing) {
      return existing;
    }

    const filename =
      options?.filename ??
      (typeof (file as File).name === "string" ? (file as File).name : fileId);
    const mimeType =
      options?.mimeType ??
      (typeof (file as File).type === "string"
        ? (file as File).type
        : "application/octet-stream");
    const rawBuffer = new Uint8Array(await file.arrayBuffer());
    const payloadBuffer = options?.encryptionKey
      ? await encryptUpdate(options.encryptionKey, rawBuffer)
      : rawBuffer;
    const chunks = chunkBuffer(payloadBuffer);
    const tree = buildMerkleTree(chunks);
    const contentId = getMerkleRoot(tree);
    const cached: CachedUpload = {
      chunks,
      tree,
      metadata: {
        fileId,
        filename,
        mimeType,
        size: payloadBuffer.length,
        totalChunks: chunks.length,
        contentId,
        encrypted: Boolean(options?.encryptionKey),
      },
    };
    this.#uploads.set(fileId, cached);
    return cached;
  }

  async #waitForRequestAck(
    reader: ReadableStreamDefaultReader<Message<Context>>,
    fileId: string,
  ): Promise<DecodedFileRequest> {
    return this.#waitForFileRequest(reader, fileId, () => true);
  }

  async #waitForCompletion(
    reader: ReadableStreamDefaultReader<Message<Context>>,
    fileId: string,
    expectedChunks: number,
  ): Promise<DecodedFileRequest> {
    return this.#waitForFileRequest(
      reader,
      fileId,
      (payload) => payload.resumeFromChunk === expectedChunks,
    );
  }

  async #waitForFileRequest(
    reader: ReadableStreamDefaultReader<Message<Context>>,
    fileId: string,
    predicate: (payload: DecodedFileRequest) => boolean,
  ): Promise<DecodedFileRequest> {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        throw new Error("File transfer stream ended unexpectedly");
      }
      if (value.type !== "file") {
        continue;
      }
      if (
        value.payload.type === "file-request" &&
        value.payload.fileId === fileId &&
        predicate(value.payload)
      ) {
        return value.payload;
      }
    }
  }
}

/**
 * Utility for streaming file downloads over the Teleportal protocol.
 */
export class FileDownloader<Context extends Record<string, unknown>> {
  async download(
    contentId: Uint8Array,
    fileId: string,
    transport: Transport<Context>,
    context: Context,
    options?: DownloadOptions,
  ): Promise<File> {
    const writer = transport.writable.getWriter();
    const reader = transport.readable.getReader();
    try {
      await writer.ready;
      await writer.write(
        new FileMessage(
          {
            type: "file-request",
            direction: "download",
            fileId,
            filename: options?.filename ?? fileId,
            size: 0,
            mimeType: options?.mimeType ?? "application/octet-stream",
            contentId,
          },
          context,
          Boolean(options?.encryptionKey),
        ),
      );

      const ack = await this.#waitForRequest(reader, fileId);
      if (ack.status === "rejected") {
        throw new Error(ack.reason ?? "Download request rejected");
      }

      const chunks = await this.#collectChunks(
        reader,
        fileId,
        ack,
        contentId,
      );
      const buffer = concatChunks(chunks);
      const decrypted =
        ack.encrypted && options?.encryptionKey
          ? await decryptUpdate(options.encryptionKey, buffer)
          : buffer;
      if (ack.encrypted && !options?.encryptionKey) {
        throw new Error("Encrypted file requires an encryption key to decrypt");
      }
      const filename = ack.filename ?? options?.filename ?? fileId;
      const mimeType =
        ack.mimeType ?? options?.mimeType ?? "application/octet-stream";
      if (typeof File !== "undefined") {
        return new File([decrypted], filename, { type: mimeType });
      }
      return new Blob([decrypted], { type: mimeType }) as File;
    } finally {
      reader.releaseLock();
      writer.releaseLock();
    }
  }

  async #waitForRequest(
    reader: ReadableStreamDefaultReader<Message<Context>>,
    fileId: string,
  ): Promise<DecodedFileRequest> {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        throw new Error("File transfer stream ended unexpectedly");
      }
      if (value.type !== "file") {
        continue;
      }
      if (
        value.payload.type === "file-request" &&
        value.payload.fileId === fileId
      ) {
        return value.payload;
      }
    }
  }

  async #collectChunks(
    reader: ReadableStreamDefaultReader<Message<Context>>,
    fileId: string,
    ack: DecodedFileRequest,
    root: Uint8Array,
  ): Promise<Uint8Array[]> {
    const totalChunks =
      typeof ack.resumeFromChunk === "number" && ack.resumeFromChunk > 0
        ? ack.resumeFromChunk
        : ack.bytesUploaded
            ? Math.ceil(ack.bytesUploaded / FILE_CHUNK_SIZE)
            : 0;
    const chunks: Uint8Array[] = new Array(totalChunks);
    let received = 0;
    while (received < totalChunks) {
      const { value, done } = await reader.read();
      if (done) {
        throw new Error("File stream ended before all chunks were received");
      }
      if (value.type !== "file" || value.payload.type !== "file-progress") {
        continue;
      }
      if (value.payload.fileId !== fileId) {
        continue;
      }
      this.#validateChunk(value.payload, root);
      if (!chunks[value.payload.chunkIndex]) {
        received++;
      }
      chunks[value.payload.chunkIndex] = value.payload.chunkData;
    }
    return chunks;
  }

  #validateChunk(payload: DecodedFileProgress, root: Uint8Array) {
    const ok = verifyMerkleProof(
      payload.chunkData,
      payload.merkleProof,
      root,
      payload.chunkIndex,
    );
    if (!ok) {
      throw new Error(`Merkle proof verification failed for chunk ${payload.chunkIndex}`);
    }
  }
}

function chunkBuffer(buffer: Uint8Array): Uint8Array[] {
  if (buffer.length === 0) {
    return [new Uint8Array(0)];
  }
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < buffer.length; offset += FILE_CHUNK_SIZE) {
    chunks.push(buffer.slice(offset, offset + FILE_CHUNK_SIZE));
  }
  return chunks;
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
