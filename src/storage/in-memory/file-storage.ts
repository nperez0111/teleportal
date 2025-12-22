import type {
  File,
  DocumentStorage,
  TemporaryUploadStorage,
} from "../types";
import { UnencryptedFileStorage } from "../unencrypted/file-storage";

/**
 * In-memory implementation of FileStorage.
 * Stores files in memory.
 */
export class InMemoryFileStorage extends UnencryptedFileStorage {
  /**
   * Completed files by fileId
   */
  #files = new Map<string, File>();

  constructor(
    documentStorage?: DocumentStorage,
    temporaryUploadStorage?: TemporaryUploadStorage,
  ) {
    super(documentStorage, temporaryUploadStorage);
  }

  async storeFile(file: File): Promise<void> {
    this.#files.set(file.id, file);
  }

  async getFile(fileId: string): Promise<File | null> {
    return this.#files.get(fileId) ?? null;
  }

  async deleteFile(fileId: string): Promise<void> {
    this.#files.delete(fileId);
  }
}
