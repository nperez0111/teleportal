import type { Storage } from "unstorage";

import { UnstorageEncryptedDocumentStorage } from "./encrypted";
import { UnstorageFileStorage } from "./file-storage";
import { UnstorageMilestoneStorage } from "./milestone-storage";
import { UnstorageTemporaryUploadStorage } from "./temporary-upload-storage";
import { UnstorageDocumentStorage } from "./unencrypted";

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
   * Key prefix for milestone storage
   * @default "{documentKeyPrefix}:milestone" or "milestone" if documentKeyPrefix is empty
   */
  milestoneKeyPrefix?: string;
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
  const documentKeyPrefix = options?.documentKeyPrefix ?? "document";

  const fileStorage = new UnstorageFileStorage(storage, {
    keyPrefix: fileKeyPrefix,
    temporaryUploadStorage: new UnstorageTemporaryUploadStorage(storage, {
      keyPrefix: fileKeyPrefix,
    }),
  });

  const milestoneKeyPrefix =
    options?.milestoneKeyPrefix ?? `${documentKeyPrefix}-milestone`;

  const milestoneStorage = new UnstorageMilestoneStorage(storage, {
    keyPrefix: milestoneKeyPrefix,
  });

  let documentStorage:
    | UnstorageDocumentStorage
    | UnstorageEncryptedDocumentStorage;
  if (options?.encrypted) {
    documentStorage = new UnstorageEncryptedDocumentStorage(storage, {
      ttl: options?.ttl,
      keyPrefix: documentKeyPrefix,
      fileStorage,
      milestoneStorage,
    });
  } else {
    documentStorage = new UnstorageDocumentStorage(storage, {
      scanKeys: options?.scanKeys ?? false,
      ttl: options?.ttl,
      keyPrefix: documentKeyPrefix,
      fileStorage,
      milestoneStorage,
    });
  }

  fileStorage.setDocumentStorage(documentStorage);

  return { fileStorage, documentStorage };
}
