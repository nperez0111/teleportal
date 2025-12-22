import type {
  FileMetadata,
  TemporaryUploadStorage,
  UploadProgress,
  File,
} from "../types";

const DEFAULT_UPLOAD_TIMEOUT_MS = 24 * 60 * 60 * 1000;

interface InMemoryUploadSession {
  metadata: FileMetadata;
  chunks: Map<number, Uint8Array>;
  lastActivity: number;
}

export class InMemoryTemporaryUploadStorage implements TemporaryUploadStorage {
  readonly type = "temporary-upload-storage";
  private uploads = new Map<string, InMemoryUploadSession>();
  private readonly uploadTimeoutMs: number;

  constructor(options?: { uploadTimeoutMs?: number }) {
    this.uploadTimeoutMs =
      options?.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
  }

  async beginUpload(uploadId: string, metadata: FileMetadata): Promise<void> {
    this.uploads.set(uploadId, {
      metadata,
      chunks: new Map(),
      lastActivity: Date.now(),
    });
  }

  async storeChunk(
    uploadId: string,
    chunkIndex: number,
    chunkData: Uint8Array,
    proof: Uint8Array[],
  ): Promise<void> {
    const session = this.uploads.get(uploadId);
    if (!session) {
      throw new Error(`Upload session ${uploadId} not found`);
    }

    session.chunks.set(chunkIndex, chunkData);
    session.lastActivity = Date.now();
  }

  async getUploadProgress(uploadId: string): Promise<UploadProgress | null> {
    const session = this.uploads.get(uploadId);
    if (!session) {
      return null;
    }

    let bytesUploaded = 0;
    const chunks = new Map<number, boolean>();

    for (const [index, data] of session.chunks.entries()) {
      chunks.set(index, true);
      bytesUploaded += data.length;
    }

    return {
      metadata: session.metadata,
      chunks,
      merkleTree: null,
      bytesUploaded,
      lastActivity: session.lastActivity,
    };
  }

  async completeUpload(
    uploadId: string,
    fileId: File["id"],
  ): Promise<{
    progress: UploadProgress;
    getChunk: (chunkIndex: number) => Promise<Uint8Array>;
  }> {
    const progress = await this.getUploadProgress(uploadId);
    if (!progress) {
      throw new Error(`Upload session ${uploadId} not found`);
    }

    const session = this.uploads.get(uploadId)!;

    return {
      progress,
      getChunk: async (chunkIndex: number) => {
        const data = session.chunks.get(chunkIndex);
        if (!data) {
          throw new Error(
            `Chunk ${chunkIndex} not found for upload ${uploadId}`,
          );
        }
        return data;
      },
    };
  }

  async cleanupExpiredUploads(): Promise<void> {
    const now = Date.now();
    for (const [id, session] of this.uploads.entries()) {
      if (now - session.lastActivity > this.uploadTimeoutMs) {
        this.uploads.delete(id);
      }
    }
  }
}
