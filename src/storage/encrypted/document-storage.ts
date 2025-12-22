import {
  decodeEncryptedUpdate,
  decodeFromStateVector,
  decodeFromSyncStep2,
  encodeEncryptedUpdateMessages,
  getEncryptedStateVector,
  getEncryptedSyncStep2,
  type DecodedEncryptedUpdatePayload,
  type EncryptedMessageId,
  type SeenMessageMapping,
} from "teleportal/protocol/encryption";
import type { EncryptedBinary } from "teleportal/encryption-key";
import {
  DocumentStorage,
  Document,
  DocumentMetadata,
  FileStorage,
  MilestoneStorage,
} from "../types";
import { StateVector, SyncStep2Update, Update } from "teleportal";

export interface EncryptedDocumentMetadata extends DocumentMetadata {
  seenMessages: SeenMessageMapping;
}

/**
 * This can definitely be optimized, I see 3 ways of improving on this:
 * 1. Introduce a "milestone" which is a snapshot of all of the seen messages compressed into a single update
 *  - These milestones can be created when:
 *    - The client is first connected to the server
 *    - The client is idle for a while
 *    - The client is reconnecting to the server
 *  - The client can then use these milestones as a starting point for the next sync
 * 2. Introduce a "compact" operation which can be used to compact the seen messages, but initiated by the server
 * 3. Move to a different storage format, like a merkle tree which could express the seen messages in a more efficient way
 *
 * One thing to do would be to have a merkle tree represent all of the seen messages, and also have a "milestone" which is a compacted version of the merkle tree.
 * If a client is paranoid, they can validate from the merkle tree, and if not they can use the milestone as a starting point. The client could even be smart
 * and implement a "trust-but-verify" strategy, where they use the milestone, but verify against the merkle tree afterwards in the background. This might prove to be a good compromise of initial sync speed and security.
 */

export abstract class EncryptedDocumentStorage implements DocumentStorage {
  readonly type = "document-storage";
  readonly storageType = "encrypted";

  abstract fileStorage?: FileStorage;
  abstract milestoneStorage?: MilestoneStorage;

  abstract writeDocumentMetadata(
    documentId: string,
    metadata: EncryptedDocumentMetadata,
  ): Promise<void>;

  abstract getDocumentMetadata(
    documentId: string,
  ): Promise<EncryptedDocumentMetadata>;

  abstract storeEncryptedMessage(
    documentId: string,
    messageId: EncryptedMessageId,
    payload: EncryptedBinary,
  ): Promise<void>;

  abstract fetchEncryptedMessage(
    documentId: string,
    messageId: EncryptedMessageId,
  ): Promise<EncryptedBinary | null>;

  abstract deleteDocument(documentId: string): Promise<void>;

  abstract transaction<T>(
    documentId: string,
    cb: () => Promise<T>,
  ): Promise<T>;

  async handleSyncStep1(
    documentId: string,
    syncStep1: StateVector,
  ): Promise<Document> {
    const decodedStateVector = decodeFromStateVector(syncStep1 as any);

    let seenMessages: SeenMessageMapping = {};
    let metadata: EncryptedDocumentMetadata;

    try {
      metadata = await this.getDocumentMetadata(documentId);
      if (metadata.seenMessages) {
        seenMessages = metadata.seenMessages;
      }
    } catch (e) {
      // Document might not exist
      metadata = {
        createdAt: Date.now(),
        updatedAt: Date.now(),
        encrypted: true,
        seenMessages: {},
      };
    }

    const encryptedSyncStep2 = await getEncryptedSyncStep2(
      seenMessages,
      (messageId) => this.fetchEncryptedMessage(documentId, messageId),
      decodedStateVector,
    );
    const encryptedStateVector = getEncryptedStateVector(seenMessages);

    return {
      id: documentId,
      metadata,
      content: {
        update: encryptedSyncStep2 as unknown as Update,
        stateVector: encryptedStateVector as unknown as StateVector,
      },
    };
  }

  private updateSeenMessages(
    seenMessages: SeenMessageMapping,
    message: DecodedEncryptedUpdatePayload,
  ): void {
    const [clientId, counter] = message.timestamp;
    if (!seenMessages[clientId]) {
      seenMessages[clientId] = {};
    }
    seenMessages[clientId][counter] = message.id;
  }

  async handleSyncStep2(
    documentId: string,
    syncStep2: SyncStep2Update,
  ): Promise<void> {
    await this.transaction(documentId, async () => {
      const decodedSyncStep2 = decodeFromSyncStep2(syncStep2 as any);
      const meta = await this.getDocumentMetadata(documentId).catch(() => ({
        createdAt: Date.now(),
        updatedAt: Date.now(),
        encrypted: true,
        seenMessages: {},
      } as EncryptedDocumentMetadata));
      
      const seenMessages = meta.seenMessages || {};

      for (const message of decodedSyncStep2.messages) {
        this.updateSeenMessages(seenMessages, message);
        await this.storeEncryptedMessage(
          documentId,
          message.id,
          message.payload,
        );
      }

      await this.writeDocumentMetadata(documentId, {
        ...meta,
        seenMessages,
      });
    });
  }

  async handleUpdate(documentId: string, update: Update): Promise<void> {
    await this.transaction(documentId, async () => {
      const meta = await this.getDocumentMetadata(documentId).catch(() => ({
        createdAt: Date.now(),
        updatedAt: Date.now(),
        encrypted: true,
        seenMessages: {},
      } as EncryptedDocumentMetadata));
      
      const seenMessages = meta.seenMessages || {};

      const encryptedUpdates = decodeEncryptedUpdate(update as any);
      for (const encryptedUpdate of encryptedUpdates) {
        this.updateSeenMessages(seenMessages, encryptedUpdate);

        await this.storeEncryptedMessage(
          documentId,
          encryptedUpdate.id,
          encryptedUpdate.payload,
        );
      }
      await this.writeDocumentMetadata(documentId, {
        ...meta,
        seenMessages,
      });
    });
  }

  async getDocument(documentId: string): Promise<Document | null> {
    try {
      const meta = await this.getDocumentMetadata(documentId);
      if (!meta) return null;
      
      const seenMessages = meta.seenMessages || {};

      const updates: DecodedEncryptedUpdatePayload[] = [];
      for (const clientId of Object.keys(seenMessages)) {
        for (const counter of Object.keys(seenMessages[parseInt(clientId)])) {
          const messageId = seenMessages[parseInt(clientId)][parseInt(counter)];
          const message = await this.fetchEncryptedMessage(
            documentId,
            messageId,
          );
          if (message) {
            updates.push({
              id: messageId,
              payload: message,
              timestamp: [parseInt(clientId), parseInt(counter)],
            });
          }
        }
      }

      const encryptedStateVector = getEncryptedStateVector(seenMessages);

      return {
        id: documentId,
        metadata: meta,
        content: {
          update: encodeEncryptedUpdateMessages(updates) as unknown as Update,
          stateVector: encryptedStateVector as unknown as StateVector,
        },
      };
    } catch (e) {
      return null;
    }
  }
}
