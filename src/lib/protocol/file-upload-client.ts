import { uuidv4 } from "lib0/random";
import type { ServerContext, Transport } from "teleportal";
import { FileMessage } from "./message-types";
import {
  buildMerkleTree,
  CHUNK_SIZE,
  generateMerkleProof,
} from "./file-upload";
import type { DecodedFileProgress, DecodedFileRequest } from "./types";

/**
 * Options for file upload.
 */
export interface FileUploadOptions {
  /**
   * Whether to encrypt the file before uploading.
   */
  encrypted?: boolean;
  /**
   * Callback for upload progress updates.
   */
  onProgress?: (progress: {
    bytesUploaded: number;
    totalBytes: number;
    chunkIndex: number;
    totalChunks: number;
  }) => void;
}

/**
 * Client-side file uploader.
 */
export class FileUploader {
  /**
   * Upload a file with merkle tree verification.
   * @param file - The file to upload
   * @param fileId - UUID for this file (client-generated)
   * @param transport - Transport for sending messages
   * @param context - Server context
   * @param options - Upload options
   * @returns The contentId (merkle root hash) of the uploaded file
   */
  static async upload<Context extends ServerContext>(
    file: File,
    fileId: string,
    transport: Transport<Context>,
    context: Context,
    options: FileUploadOptions = {},
  ): Promise<Uint8Array> {
    const { encrypted = false, onProgress } = options;

    // Read file data
    const fileData = await file.arrayBuffer();
    let dataToUpload = new Uint8Array(fileData);

    // TODO: Encrypt file if encrypted flag is set
    // For now, we'll skip encryption implementation as it's complex
    // and would require encryption key management

    // Split into chunks
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < dataToUpload.length; i += CHUNK_SIZE) {
      chunks.push(dataToUpload.slice(i, i + CHUNK_SIZE));
    }

    // Build merkle tree
    const merkleTree = buildMerkleTree(chunks);
    const contentId = merkleTree.root.hash;

    // Send file request
    const requestMessage = new FileMessage<Context>(
      {
        type: "file-request",
        direction: "upload",
        fileId,
        filename: file.name,
        size: file.size,
        mimeType: file.type || "application/octet-stream",
      },
      context,
      encrypted,
    );

    await transport.writable.getWriter().write(requestMessage);

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

      await transport.writable.getWriter().write(progressMessage);

      bytesUploaded += chunk.length;

      if (onProgress) {
        onProgress({
          bytesUploaded,
          totalBytes: file.size,
          chunkIndex: i,
          totalChunks: chunks.length,
        });
      }
    }

    return contentId;
  }

  /**
   * Resume an upload from the last uploaded chunk.
   * @param fileId - UUID for this file
   * @param transport - Transport for sending messages
   * @returns The contentId (merkle root hash) if upload completes
   */
  static async resumeUpload<Context extends ServerContext>(
    fileId: string,
    transport: Transport<Context>,
  ): Promise<Uint8Array> {
    // TODO: Implement resume logic
    // This would require:
    // 1. Querying server for upload progress
    // 2. Reading file from where we left off
    // 3. Sending remaining chunks
    throw new Error("Resume upload not yet implemented");
  }
}

/**
 * Client-side file downloader.
 */
export class FileDownloader {
  /**
   * Download a file by its contentId.
   * @param contentId - The contentId (merkle root hash) of the file
   * @param fileId - UUID for this download session
   * @param transport - Transport for sending/receiving messages
   * @param context - Server context
   * @returns The downloaded file
   */
  static async download<Context extends ServerContext>(
    contentId: Uint8Array,
    fileId: string,
    transport: Transport<Context>,
    context: Context,
  ): Promise<File> {
    // Send download request
    const requestMessage = new FileMessage<Context>(
      {
        type: "file-request",
        direction: "download",
        fileId,
        filename: "", // Will be provided by server
        size: 0, // Will be provided by server
        mimeType: "", // Will be provided by server
        contentId,
      },
      context,
      false, // Downloads are not encrypted (file is already encrypted if needed)
    );

    await transport.writable.getWriter().write(requestMessage);

    // TODO: Implement download streaming
    // This would require:
    // 1. Receiving file metadata from server
    // 2. Receiving chunks with merkle proofs
    // 3. Verifying each chunk
    // 4. Reassembling file
    // 5. Decrypting if needed

    throw new Error("Download not yet fully implemented");
  }
}
