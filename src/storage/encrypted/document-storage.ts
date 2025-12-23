import type {
  DecodedEncryptedUpdatePayload,
  EncryptedMessageId,
  EncryptedStateVector,
  EncryptedSyncStep2,
  EncryptedUpdatePayload,
  SeenMessageMapping,
} from "teleportal/protocol/encryption";
import {
  decodeEncryptedUpdate,
  decodeFromStateVector,
  decodeFromSyncStep2,
  encodeEncryptedUpdateMessages,
  getEncryptedStateVector,
  getEncryptedSyncStep2,
} from "teleportal/protocol/encryption";
import {
  type DocumentMetadata as BaseDocumentMetadata,
  type DocumentStorage,
  type FileStorage,
  type MilestoneStorage,
  type Document,
} from "../types";
import { EncryptedBinary } from "teleportal/encryption-key";

export interface EncryptedDocumentMetadata extends BaseDocumentMetadata {
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
  readonly type = "document-storage" as const;
  storageType: "encrypted" = "encrypted";

  fileStorage?: FileStorage;
  milestoneStorage?: MilestoneStorage;

  abstract writeDocumentMetadata(
    key: string,
    metadata: EncryptedDocumentMetadata,
  ): Promise<void>;

  abstract getDocumentMetadata(key: string): Promise<EncryptedDocumentMetadata>;

  abstract storeEncryptedMessage(
    key: string,
    messageId: EncryptedMessageId,
    payload: EncryptedBinary,
  ): Promise<void>;

  abstract fetchEncryptedMessage(
    key: string,
    messageId: EncryptedMessageId,
  ): Promise<EncryptedBinary | null>;

  async handleSyncStep1(
    key: string,
    syncStep1: EncryptedStateVector,
  ): Promise<Document> {
    const decodedStateVector = decodeFromStateVector(syncStep1);
    const { seenMessages, ...rest } = await this.getDocumentMetadata(key);

    const encryptedSyncStep2 = await getEncryptedSyncStep2(
      seenMessages,
      (messageId) => this.fetchEncryptedMessage(key, messageId),
      decodedStateVector,
    );
    const encryptedStateVector = getEncryptedStateVector(seenMessages);

    return {
      id: key,
      metadata: {
        // Spread first to preserve any stored values, then override with sanitized defaults
        ...(rest as any),
        createdAt:
          typeof (rest as any).createdAt === "number"
            ? (rest as any).createdAt
            : Date.now(),
        updatedAt: Date.now(),
        encrypted: true,
        seenMessages,
      },
      content: {
        update: encryptedSyncStep2 as unknown as any,
        stateVector: encryptedStateVector as unknown as any,
      },
    } satisfies Document;
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
    key: string,
    syncStep2: EncryptedSyncStep2,
  ): Promise<void> {
    await this.transaction(key, async () => {
      const decodedSyncStep2 = decodeFromSyncStep2(syncStep2);
      const { seenMessages, ...rest } = await this.getDocumentMetadata(key);
      for (const message of decodedSyncStep2.messages) {
        this.updateSeenMessages(seenMessages, message);
        await this.storeEncryptedMessage(key, message.id, message.payload);
      }
      await this.writeDocumentMetadata(key, {
        ...rest,
        updatedAt: Date.now(),
        seenMessages,
      } as EncryptedDocumentMetadata);
    });
  }

  async handleUpdate(
    key: string,
    update: EncryptedUpdatePayload,
  ): Promise<void> {
    await this.transaction(key, async () => {
      const { seenMessages, ...rest } = await this.getDocumentMetadata(key);
      const encryptedUpdates = decodeEncryptedUpdate(update);
      for (const encryptedUpdate of encryptedUpdates) {
        this.updateSeenMessages(seenMessages, encryptedUpdate);

        await this.storeEncryptedMessage(
          key,
          encryptedUpdate.id,
          encryptedUpdate.payload,
        );
      }
      await this.writeDocumentMetadata(key, {
        ...rest,
        updatedAt: Date.now(),
        seenMessages,
      } as EncryptedDocumentMetadata);
    });
  }

  async getDocument(key: string): Promise<Document> {
    // TODO maybe a more efficient way to do this?
    const metadata = await this.getDocumentMetadata(key);
    const { seenMessages } = metadata;
    const updates: DecodedEncryptedUpdatePayload[] = [];
    for (const clientId of Object.keys(seenMessages)) {
      for (const counter of Object.keys(seenMessages[parseInt(clientId)])) {
        const messageId = seenMessages[parseInt(clientId)][parseInt(counter)];
        const message = await this.fetchEncryptedMessage(key, messageId);
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
      id: key,
      metadata: {
        // Spread first to preserve any stored values, then override with sanitized defaults
        ...(metadata as any),
        createdAt:
          typeof (metadata as any).createdAt === "number"
            ? (metadata as any).createdAt
            : Date.now(),
        updatedAt:
          typeof (metadata as any).updatedAt === "number"
            ? (metadata as any).updatedAt
            : Date.now(),
        encrypted: true,
      },
      content: {
        update: encodeEncryptedUpdateMessages(updates) as unknown as any,
        stateVector: encryptedStateVector as unknown as any,
      },
    } satisfies Document;
  }

  abstract deleteDocument(key: string): Promise<void>;

  transaction<T>(key: string, cb: () => Promise<T>): Promise<T> {
    return cb();
  }
}
