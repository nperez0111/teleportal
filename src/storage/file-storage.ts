import { toBase64 } from "lib0/buffer";
import {
  buildMerkleTree,
  FILE_CHUNK_SIZE,
  getMerkleRoot,
  serializeMerkleTree,
  verifyMerkleProof,
} from "../lib/protocol/file-upload";

export type FileMetadata = {
  fileId: string;
  filename: string;
  size: number;
  mimeType: string;
  totalChunks: number;
  encrypted: boolean;
  contentId?: Uint8Array;
  initiatedBy?: string;
  createdAt?: number;
};

export type UploadProgress = {
  fileId: string;
  bytesUploaded: number;
  totalChunks: number;
  chunksReceived: number;
  size: number;
  encrypted: boolean;
  updatedAt: number;
  expiresAt: number;
  contentId?: Uint8Array;
};

export type FileData = {
  contentId: Uint8Array;
  metadata: FileMetadata;
  chunks: Uint8Array[];
  merkleTree: Uint8Array;
  createdAt: number;
};

export interface FileStorage {
  initiateUpload(fileId: string, metadata: FileMetadata): Promise<void>;
  storeChunk(
    fileId: string,
    chunkIndex: number,
    chunkData: Uint8Array,
    proof: Uint8Array[],
  ): Promise<void>;
  getUploadProgress(fileId: string): Promise<UploadProgress | null>;
  completeUpload(fileId: string): Promise<Uint8Array>;
  getFile(contentId: string): Promise<FileData | null>;
  cleanupExpiredUploads(): Promise<void>;
}

type UploadSession = {
  metadata: FileMetadata;
  chunks: Map<number, Uint8Array>;
  bytesUploaded: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
};

type StoredFile = {
  data: FileData;
};

export type InMemoryFileStorageOptions = {
  uploadTtlMs?: number;
};

export class InMemoryFileStorage implements FileStorage {
  #uploads = new Map<string, UploadSession>();
  #files = new Map<string, StoredFile>();
  #uploadTtlMs: number;

  constructor(options?: InMemoryFileStorageOptions) {
    this.#uploadTtlMs = options?.uploadTtlMs ?? 24 * 60 * 60 * 1000;
  }

  async initiateUpload(fileId: string, metadata: FileMetadata): Promise<void> {
    const now = Date.now();
    const totalChunks =
      metadata.totalChunks ??
      Math.max(1, Math.ceil(metadata.size / FILE_CHUNK_SIZE));
    const normalizedMetadata: FileMetadata = {
      ...metadata,
      totalChunks,
      createdAt: now,
    };
    this.#uploads.set(fileId, {
      metadata: normalizedMetadata,
      chunks: new Map(),
      bytesUploaded: 0,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + this.#uploadTtlMs,
    });
  }

  async storeChunk(
    fileId: string,
    chunkIndex: number,
    chunkData: Uint8Array,
    proof: Uint8Array[],
  ): Promise<void> {
    const session = this.#uploads.get(fileId);
    if (!session) {
      throw new Error(`Upload session not found for file ${fileId}`);
    }
    if (Date.now() > session.expiresAt) {
      this.#uploads.delete(fileId);
      throw new Error(`Upload session expired for file ${fileId}`);
    }
    if (chunkIndex < 0 || chunkIndex >= session.metadata.totalChunks) {
      throw new RangeError("Chunk index out of bounds");
    }
    if (chunkData.length > FILE_CHUNK_SIZE) {
      throw new Error("Chunk exceeds maximum chunk size");
    }
    if (!session.metadata.contentId) {
      throw new Error("Cannot verify chunk without contentId");
    }

    const valid = verifyMerkleProof(
      chunkData,
      proof,
      session.metadata.contentId,
      chunkIndex,
    );
    if (!valid) {
      throw new Error("Merkle proof verification failed");
    }

    const existing = session.chunks.get(chunkIndex);
    if (!existing || existing.length !== chunkData.length) {
      session.chunks.set(chunkIndex, chunkData.slice());
      if (!existing) {
        session.bytesUploaded += chunkData.length;
      } else {
        session.bytesUploaded += chunkData.length - existing.length;
      }
    }
    session.updatedAt = Date.now();
  }

  async getUploadProgress(fileId: string): Promise<UploadProgress | null> {
    const session = this.#uploads.get(fileId);
    if (!session) {
      return null;
    }
    return {
      fileId,
      bytesUploaded: session.bytesUploaded,
      totalChunks: session.metadata.totalChunks,
      chunksReceived: session.chunks.size,
      size: session.metadata.size,
      encrypted: session.metadata.encrypted,
      updatedAt: session.updatedAt,
      expiresAt: session.expiresAt,
      contentId: session.metadata.contentId,
    };
  }

  async completeUpload(fileId: string): Promise<Uint8Array> {
    const session = this.#uploads.get(fileId);
    if (!session) {
      throw new Error(`Upload session not found for file ${fileId}`);
    }
    if (session.chunks.size !== session.metadata.totalChunks) {
      throw new Error("Upload incomplete, not all chunks stored");
    }

    const chunks: Uint8Array[] = [];
    for (let i = 0; i < session.metadata.totalChunks; i++) {
      const chunk = session.chunks.get(i);
      if (!chunk) {
        throw new Error(`Missing chunk ${i} for file ${fileId}`);
      }
      chunks.push(chunk);
    }

    const tree = buildMerkleTree(chunks);
    const computedRoot = getMerkleRoot(tree);
    if (!session.metadata.contentId) {
      throw new Error("Upload metadata missing expected contentId");
    }
    if (toBase64(computedRoot) !== toBase64(session.metadata.contentId)) {
      throw new Error("Computed merkle root does not match provided contentId");
    }

    const stored: StoredFile = {
      data: {
        contentId: computedRoot,
        metadata: {
          ...session.metadata,
          contentId: computedRoot,
        },
        chunks,
        merkleTree: serializeMerkleTree(tree),
        createdAt: Date.now(),
      },
    };

    this.#files.set(toBase64(computedRoot), stored);
    this.#uploads.delete(fileId);
    return computedRoot;
  }

  async getFile(contentId: string): Promise<FileData | null> {
    return this.#files.get(contentId)?.data ?? null;
  }

  async cleanupExpiredUploads(): Promise<void> {
    const now = Date.now();
    for (const [fileId, session] of this.#uploads.entries()) {
      if (session.expiresAt <= now) {
        this.#uploads.delete(fileId);
      }
    }
  }
}
