import { defineMethod, defineProtocol } from "teleportal/rpc";

/**
 * File part stream payload for chunked file transfers.
 * Used as the stream payload type for both upload and download RPC methods.
 */
export type FilePartStream = {
  /**
   * Client-generated UUID identifying this file transfer
   */
  fileId: string;
  /**
   * Zero-based index of this chunk
   */
  chunkIndex: number;
  /**
   * Chunk data (64KB)
   */
  chunkData: Uint8Array;
  /**
   * Merkle proof path for this chunk
   */
  merkleProof: Uint8Array[];
  /**
   * Total number of chunks in the file
   */
  totalChunks: number;
  /**
   * Total bytes uploaded so far
   */
  bytesUploaded: number;
  /**
   * Whether the file is encrypted
   */
  encrypted: boolean;
};

export type FileUploadRequest = {
  fileId: string;
  filename: string;
  size: number;
  mimeType: string;
  lastModified: number;
  encrypted: boolean;
};

export type FileUploadResponse = {
  fileId: string;
  allowed: boolean;
  reason?: string;
  statusCode?: number;
  existingChunks?: number[];
};

export type FileDownloadRequest = {
  fileId: string;
};

export type FileDownloadResponse = {
  fileId: string;
  filename: string;
  size: number;
  mimeType: string;
  lastModified: number;
  encrypted: boolean;
  allowed: boolean;
  reason?: string;
  statusCode?: number;
};

// ---------------------------------------------------------------------------
// Method contracts — type-first (binary payloads, no schema validation)
// ---------------------------------------------------------------------------

export const fileUpload = defineMethod<
  "fileUpload",
  FileUploadRequest,
  FileUploadResponse,
  FilePartStream
>("fileUpload", { kind: "multipart" });

export const fileDownload = defineMethod<"fileDownload", FileDownloadRequest, FileDownloadResponse>(
  "fileDownload",
);

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

export const fileProtocol = defineProtocol("file", {
  upload: fileUpload,
  download: fileDownload,
});
