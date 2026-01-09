import type {
  DocumentStorage,
  FileStorage,
} from "../types";
import { EncryptedMemoryStorage } from "./encrypted";
import { InMemoryFileStorage } from "./file-storage";
import { InMemoryTemporaryUploadStorage } from "./temporary-upload-storage";
import { YDocStorage } from "./ydoc";

/**
 * Options for creating in-memory storage
 */
export interface CreateInMemoryOptions {
  /**
   * Whether to use encrypted document storage
   * @default false
   */
  encrypted?: boolean;
  /**
   * Whether to use YDoc storage (for Y.js documents)
   * @default false
   */
  useYDoc?: boolean;
}

/**
 * Result of creating in-memory storage
 */
export interface InMemoryStorage {
  /**
   * The file storage instance
   */
  fileStorage: InMemoryFileStorage;
  /**
   * The document storage instance
   */
  documentStorage: DocumentStorage;
}

/**
 * Creates document and file storage for in-memory storage.
 * Both storages share the same in-memory data structures.
 *
 * @param options - Configuration options
 * @returns Document and file storage instances
 */
export function createInMemory(
  options?: CreateInMemoryOptions,
): InMemoryStorage {
  const fileStorage = new InMemoryFileStorage({
    temporaryUploadStorage: new InMemoryTemporaryUploadStorage(),
  });

  let documentStorage: DocumentStorage;
  if (options?.encrypted) {
    documentStorage = new EncryptedMemoryStorage(undefined, fileStorage);
  } else if (options?.useYDoc) {
    documentStorage = new YDocStorage(fileStorage);
  } else {
    documentStorage = new YDocStorage(fileStorage);
  }

  fileStorage.setDocumentStorage(documentStorage);

  return { fileStorage, documentStorage };
}
