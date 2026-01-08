import type { Storage } from "unstorage";

import type {
  DocumentStorage,
  FileStorage,
} from "../types";
import { UnstorageEncryptedDocumentStorage } from "./encrypted";
import { UnstorageFileStorage } from "./file-storage";
import { UnstorageDocumentStorage } from "./unencrypted";
import { UnstorageTemporaryUploadStorage } from "./temporary-upload-storage";

/**
 * Options for creating unstorage-based storage
 */
export interface CreateUnstorageOptions {
  /**
   * Key prefix for file storage
   * @default "file"
   */
  fileKeyPrefix?: string;
  /**
   * Key prefix for document storage
   * @default ""
   */
  documentKeyPrefix?: string;
  /**
   * Whether to use encrypted document storage
   * @default false
   */
  encrypted?: boolean;
  /**
   * Whether to scan keys for updates (useful in relational DBs)
   * @default false
   */
  scanKeys?: boolean;
  /**
   * Transaction TTL in milliseconds
   * @default 5000
   */
  ttl?: number;
}

/**
 * Result of creating unstorage-based storage
 */
export interface UnstorageStorage {
  /**
   * The file storage instance
   */
  fileStorage: UnstorageFileStorage;
  /**
   * The document storage instance
   */
  documentStorage: UnstorageDocumentStorage | UnstorageEncryptedDocumentStorage;
}

/**
 * Creates document and file storage based on the same unstorage instance.
 * Both storages use the same underlying storage with different key prefixes.
 *
 * @param storage - The unstorage instance to use
 * @param options - Configuration options
 * @returns Document and file storage instances
 */
export function createUnstorage(
  storage: Storage,
  options?: CreateUnstorageOptions,
): UnstorageStorage {
  const fileKeyPrefix = options?.fileKeyPrefix ?? "file";
  const documentKeyPrefix = options?.documentKeyPrefix ?? "";

  const fileStorage = new UnstorageFileStorage(storage, {
    keyPrefix: fileKeyPrefix,
    temporaryUploadStorage: new UnstorageTemporaryUploadStorage(storage, {
      keyPrefix: fileKeyPrefix,
    }),
  });

  let documentStorage: UnstorageDocumentStorage | UnstorageEncryptedDocumentStorage;
  if (options?.encrypted) {
    documentStorage = new UnstorageEncryptedDocumentStorage(storage, {
      ttl: options?.ttl,
      keyPrefix: documentKeyPrefix,
      fileStorage,
    });
  } else {
    documentStorage = new UnstorageDocumentStorage(storage, {
      scanKeys: options?.scanKeys ?? false,
      ttl: options?.ttl,
      keyPrefix: documentKeyPrefix,
      fileStorage,
    });
  }

  fileStorage.setDocumentStorage(documentStorage);

  return { fileStorage, documentStorage };
}
