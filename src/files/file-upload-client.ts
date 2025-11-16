import type { ClientContext, Transport } from "teleportal";
import { FileMessage } from "teleportal/protocol";
import {
  buildMerkleTree,
  CHUNK_SIZE,
  generateMerkleProof,
} from "./file-upload";

/**
 * File uploader for streaming file uploads with merkle tree verification.
 */
export class FileUploader {
  /**
   * Upload a file in chunks with merkle tree verification.
   *
   * @param file - The file to upload
   * @param fileId - Client-generated UUID for this upload
   * @param transport - Transport for sending messages
   * @param context - Client context
   * @param encrypted - Whether to encrypt the file
   * @returns The contentId (merkle root hash) of the uploaded file
   */
  async upload(
    file: File,
    fileId: string,
    transport: Transport<ClientContext, any>,
    context: ClientContext,
    encrypted: boolean = false,
  ): Promise<Uint8Array> {
    // Read file into memory (for small files) or stream
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

    // Build merkle tree
    const merkleTree = buildMerkleTree(chunks);
    const contentId = merkleTree.nodes[merkleTree.nodes.length - 1].hash;

    // Send file request
    const requestMessage = new FileMessage<ClientContext>(
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

    await transport.writable.getWriter().write(requestMessage);

    // Wait for approval (simplified - in production, should wait for response)
    // For now, we'll proceed with sending chunks

    // Send chunks with merkle proofs
    let bytesUploaded = 0;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const proof = generateMerkleProof(merkleTree, i);

      const progressMessage = new FileMessage<ClientContext>(
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
    }

    // Complete upload (server should verify and complete)
    // The server will verify the merkle root matches contentId

    return contentId;
  }

  /**
   * Resume an upload from the last uploaded chunk.
   *
   * @param fileId - Client-generated UUID for this upload
   * @param transport - Transport for sending messages
   * @param context - Client context
   * @returns The contentId (merkle root hash) of the uploaded file
   */
  async resumeUpload(
    fileId: string,
    transport: Transport<ClientContext, any>,
    context: ClientContext,
  ): Promise<Uint8Array> {
    // Request upload progress from server
    // For now, this is a placeholder - would need server support for progress queries
    throw new Error("Resume upload not yet implemented");
  }
}

/**
 * File downloader for streaming file downloads.
 */
export class FileDownloader {
  /**
   * Download a file by contentId.
   *
   * @param contentId - Merkle root hash (contentId) of the file
   * @param fileId - Client-generated UUID for this download
   * @param transport - Transport for sending/receiving messages
   * @param context - Client context
   * @param encrypted - Whether the file is encrypted
   * @returns The downloaded file
   */
  async download(
    contentId: Uint8Array,
    fileId: string,
    transport: Transport<ClientContext, any>,
    context: ClientContext,
    encrypted: boolean = false,
  ): Promise<File> {
    // Send download request
    const requestMessage = new FileMessage<ClientContext>(
      {
        type: "file-request",
        direction: "download",
        fileId,
        filename: "", // Will be filled by server
        size: 0, // Will be filled by server
        mimeType: "", // Will be filled by server
        contentId,
      },
      context,
      encrypted,
    );

    await transport.writable.getWriter().write(requestMessage);

    // Wait for file data (simplified - in production, should stream chunks)
    // For now, this is a placeholder - would need server support for chunk streaming
    throw new Error("File download streaming not yet implemented");
  }
}
