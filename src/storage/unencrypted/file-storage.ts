import {
  FileStorage,
  File,
  FileMetadata,
  TemporaryUploadStorage,
  DocumentStorage,
} from "../types";

/**
 * Base class for unencrypted file storage implementations.
 *
 * This provides a simpler interface for unencrypted files, where the file data
 * is stored without encryption.
 *
 * Concrete implementations should extend this class and provide implementations
 * for the abstract storage methods.
 */
export abstract class UnencryptedFileStorage implements FileStorage {
  readonly type = "file-storage";
  public temporaryUploadStorage?: TemporaryUploadStorage;

  constructor(
    protected documentStorage?: DocumentStorage,
    temporaryUploadStorage?: TemporaryUploadStorage,
  ) {
    this.temporaryUploadStorage = temporaryUploadStorage;
  }

  /**
   * Store a completed file.
   * This is not part of the FileStorage interface but required for implementations.
   */
  abstract storeFile(file: File): Promise<void>;

  abstract getFile(fileId: string): Promise<File | null>;
  abstract deleteFile(fileId: string): Promise<void>;

  /**
   * Helper to get just metadata. Implementations can optimize this.
   * Default implementation calls getFile().
   */
  protected async getFileMetadata(fileId: string): Promise<FileMetadata | null> {
    const file = await this.getFile(fileId);
    return file ? file.metadata : null;
  }

  async listFileMetadataByDocument(
    documentId: string,
  ): Promise<FileMetadata[]> {
    if (!this.documentStorage) return [];
    try {
      const metadata = await this.documentStorage.getDocumentMetadata(
        documentId,
      );
      if (!metadata.files) return [];

      const files = await Promise.all(
        metadata.files.map((id) => this.getFileMetadata(id)),
      );
      return files.filter((f): f is FileMetadata => f !== null);
    } catch (e) {
      return [];
    }
  }

  async deleteFilesByDocument(documentId: string): Promise<void> {
    if (!this.documentStorage) return;
    try {
      const metadata = await this.documentStorage.getDocumentMetadata(
        documentId,
      );
      if (!metadata.files) return;

      await Promise.all(metadata.files.map((id) => this.deleteFile(id)));
    } catch (e) {
      // ignore
    }
  }
}
