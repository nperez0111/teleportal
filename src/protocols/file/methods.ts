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
  /**
   * Content-addressed id: the base64 merkle root over the (encrypted) chunks,
   * computed by the client before the request. It is both the upload session id
   * and the durable file id, which is what makes uploads resumable (a re-upload
   * of the same content re-derives the same id and finds the existing session)
   * and deduplicated (the server can answer `alreadyExists` before any chunk is
   * streamed).
   */
  fileId: string;
  filename: string;
  size: number;
  mimeType: string;
  lastModified: number;
  encrypted: boolean;
  /**
   * The wire chunk size the client chunked with. Lets the server detect a
   * chunk-size mismatch (which would make the client's fileId/chunking invalid)
   * and ask the client to recompute with the server's size.
   */
  chunkSize?: number;
};

export type FileUploadResponse = {
  fileId: string;
  allowed: boolean;
  reason?: string;
  statusCode?: number;
  existingChunks?: number[];
  chunkSize?: number;
  /**
   * True when the content already exists durably (dedup hit): the file has been
   * attached to this document and the client can resolve without streaming.
   */
  alreadyExists?: boolean;
  /**
   * Set when the client's `chunkSize` did not match the server's. No upload
   * session was created; the client must re-chunk/re-encrypt with `chunkSize`
   * (which will change its `fileId`) and send a new request.
   */
  chunkSizeMismatch?: boolean;
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
  totalChunks?: number;
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
