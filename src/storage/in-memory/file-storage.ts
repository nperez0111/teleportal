import { CHUNK_SIZE } from "../../lib/merkle-tree/merkle-tree";
import type {
  File,
  FileStorage,
  FileUploadResult,
  TemporaryUploadStorage,
} from "../types";
import type { InMemoryTemporaryUploadStorage } from "./temporary-upload-storage";

/**
 * In-memory implementation of {@link FileStorage}.
 *
 * @note Upload session management is handled by a {@link TemporaryUploadStorage}
 * implementation (see {@link InMemoryTemporaryUploadStorage}).
 */
export class InMemoryFileStorage implements FileStorage {
  readonly type = "file-storage" as const;

  temporaryUploadStorage?: TemporaryUploadStorage;
  #files = new Map<string, File>();

  constructor(options?: {
    temporaryUploadStorage?: TemporaryUploadStorage;
  }) {
    this.temporaryUploadStorage = options?.temporaryUploadStorage;
  }

  /**
   * Store a completed file (helper for temporary upload storage composition).
   * This is intentionally not part of the public `FileStorage` interface.
   */
  async storeFile(file: File): Promise<void> {
    this.#files.set(file.id, file);
  }

  async getFile(fileId: File["id"]): Promise<File | null> {
    return this.#files.get(fileId) ?? null;
  }

  /**
   * Internal method to delete file data without updating document metadata.
   * This avoids transaction deadlocks when called from within a transaction.
   */
  #deleteFileData(fileId: File["id"]): File | null {
    const file = this.#files.get(fileId);
    this.#files.delete(fileId);
    return file ?? null;
  }

  async deleteFile(fileId: File["id"]): Promise<void> {
    this.#deleteFileData(fileId);
  }

  async storeFileFromUpload(uploadResult: FileUploadResult): Promise<void> {
    const expectedChunks =
      uploadResult.progress.metadata.size === 0
        ? 1
        : Math.ceil(uploadResult.progress.metadata.size / CHUNK_SIZE);

    // Fetch all chunks incrementally and store them
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < expectedChunks; i++) {
      const chunk = await uploadResult.getChunk(i);
      chunks.push(chunk);
    }

    const file: File = {
      id: uploadResult.fileId,
      metadata: uploadResult.progress.metadata,
      chunks,
      contentId: uploadResult.contentId,
    };

    await this.storeFile(file);
  }
}
