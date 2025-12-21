import type { Storage } from "unstorage";

import { EncryptedBinary } from "teleportal/encryption-key";
import type { EncryptedMessageId } from "teleportal/protocol/encryption";
import {
  EncryptedDocumentMetadata,
  EncryptedDocumentStorage,
} from "../encrypted/document-storage";
import { FileStorage, MilestoneStorage } from "../types";

export class UnstorageEncryptedDocumentStorage extends EncryptedDocumentStorage {
  private readonly storage: Storage;
  private readonly options: { ttl: number };
  public readonly fileStorage: FileStorage | undefined;
  public readonly milestoneStorage: MilestoneStorage | undefined;

  constructor(
    storage: Storage,
    options?: {
      ttl?: number;
      fileStorage?: FileStorage;
      milestoneStorage?: MilestoneStorage;
    },
  ) {
    super();
    this.storage = storage;
    this.options = { ttl: 5 * 1000, ...options };
    this.fileStorage = options?.fileStorage;
    this.milestoneStorage = options?.milestoneStorage;
  }

  /**
   * Lock a key for 5 seconds
   * @param documentId - The key to lock
   * @param cb - The callback to execute
   * @returns The TTL of the lock
   */
  async transaction<T>(documentId: string, cb: () => Promise<T>): Promise<T> {
    const meta = await this.storage.getMeta(documentId);
    const lockedTTL = meta?.ttl;
    if (lockedTTL && lockedTTL > Date.now()) {
      // Wait for the lock to be released with jitter to avoid thundering herd
      const jitter = Math.random() * 1000; // Random delay between 0-1000ms
      const waitTime = lockedTTL - Date.now() + jitter;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
      return await this.transaction(documentId, cb);
    }
    const ttl = Date.now() + this.options.ttl;
    await this.storage.setMeta(documentId, { ttl, ...meta });
    const result = await cb();
    await this.storage.setMeta(documentId, { ttl: Date.now(), ...meta });
    return result;
  }

  async writeDocumentMetadata(
    documentId: string,
    metadata: EncryptedDocumentMetadata,
  ): Promise<void> {
    await this.storage.setItem(documentId + ":meta", metadata);
  }

  async getDocumentMetadata(
    documentId: string,
  ): Promise<EncryptedDocumentMetadata> {
    const metadata = await this.storage.getItem(documentId + ":meta");
    if (!metadata) {
      return {
        createdAt: Date.now(),
        updatedAt: Date.now(),
        encrypted: true,
        seenMessages: {},
      };
    }
    return metadata as EncryptedDocumentMetadata;
  }

  async storeEncryptedMessage(
    documentId: string,
    messageId: EncryptedMessageId,
    payload: EncryptedBinary,
  ): Promise<void> {
    await this.storage.setItemRaw<EncryptedBinary>(
      documentId + ":" + messageId,
      payload,
    );
  }

  async fetchEncryptedMessage(
    documentId: string,
    messageId: EncryptedMessageId,
  ): Promise<EncryptedBinary | null> {
    const payload = await this.storage.getItemRaw<EncryptedBinary>(
      documentId + ":" + messageId,
    );
    return payload;
  }

  async deleteDocument(documentId: string): Promise<void> {
    if (this.fileStorage) {
      await this.fileStorage.deleteFilesByDocument(documentId);
    }

    if (this.milestoneStorage) {
      const milestones = await this.milestoneStorage.getMilestones(documentId);
      if (milestones.length > 0) {
        await this.milestoneStorage.deleteMilestone(
          documentId,
          milestones.map((m) => m.id),
        );
      }
    }

    const metadata = await this.getDocumentMetadata(documentId);

    // Delete all messages
    const promises = [];
    if (metadata.seenMessages) {
      for (const clientId in metadata.seenMessages) {
        for (const counter in metadata.seenMessages[clientId]) {
          const messageId = metadata.seenMessages[clientId][counter];
          promises.push(
            this.storage.removeItem(documentId + ":" + messageId),
          );
        }
      }
    }
    await Promise.all(promises);

    // Delete metadata
    await this.storage.removeItem(documentId + ":meta");
  }
}
