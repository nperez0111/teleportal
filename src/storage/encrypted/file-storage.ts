import type { FileMetadata } from "../file-storage";
import { UnencryptedFileStorage } from "../unencrypted/file-storage";

/**
 * Base class for encrypted file storage implementations.
 *
 * This extends UnencryptedFileStorage since encrypted files work the same way -
 * chunks are already encrypted client-side before being uploaded, so merkle tree
 * operations work identically to unencrypted files.
 *
 * The only difference is that this class validates that metadata.encrypted is true
 * and sets the encrypted flag to true.
 *
 * Concrete implementations should extend this class and provide implementations
 * for the abstract storage methods (inherited from UnencryptedFileStorage).
 */
export abstract class EncryptedFileStorage extends UnencryptedFileStorage {
  public encrypted = true;

  /**
   * Override to validate that metadata.encrypted is true.
   */
  async initiateUpload(fileId: string, metadata: FileMetadata): Promise<void> {
    if (!metadata.encrypted) {
      throw new Error(
        `EncryptedFileStorage requires encrypted: true in metadata for file ${fileId}`,
      );
    }

    // Call parent implementation
    await super.initiateUpload(fileId, metadata);
  }
}
