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
  AttributionMetadata,
  DocumentStorage,
  type DocumentMetadata as BaseDocumentMetadata,
} from "../document-storage";
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

export abstract class EncryptedDocumentStorage extends DocumentStorage {
  public encrypted = true;

  abstract writeDocumentMetadata(
    key: string,
    metadata: EncryptedDocumentMetadata,
  ): Promise<void>;

  abstract fetchDocumentMetadata(
    key: string,
  ): Promise<EncryptedDocumentMetadata>;

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
  ): Promise<{
    update: EncryptedSyncStep2;
    stateVector: EncryptedStateVector;
  }> {
    const decodedStateVector = decodeFromStateVector(syncStep1);
    const { seenMessages } = await this.fetchDocumentMetadata(key);

    const encryptedSyncStep2 = await getEncryptedSyncStep2(
      seenMessages,
      (messageId) => this.fetchEncryptedMessage(key, messageId),
      decodedStateVector,
    );
    const encryptedStateVector = getEncryptedStateVector(seenMessages);

    return {
      update: encryptedSyncStep2,
      stateVector: encryptedStateVector,
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
    key: string,
    syncStep2: EncryptedSyncStep2,
    attribution?: AttributionMetadata,
  ): Promise<void> {
    void attribution;
    await this.transaction(key, async () => {
      const decodedSyncStep2 = decodeFromSyncStep2(syncStep2);
      const { seenMessages, ...rest } = await this.fetchDocumentMetadata(key);
      for (const message of decodedSyncStep2.messages) {
        this.updateSeenMessages(seenMessages, message);
        await this.storeEncryptedMessage(key, message.id, message.payload);
      }
      await this.writeDocumentMetadata(key, {
        ...rest,
        seenMessages,
      });
    });
  }

  async write(
    key: string,
    update: EncryptedUpdatePayload,
    attribution?: AttributionMetadata,
  ): Promise<void> {
    void attribution;
    await this.transaction(key, async () => {
      const { seenMessages, ...rest } = await this.fetchDocumentMetadata(key);
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
        seenMessages,
      });
    });
  }

  async fetch(key: string): Promise<{
    update: EncryptedUpdatePayload;
    stateVector: EncryptedStateVector;
  }> {
    // TODO maybe a more efficient way to do this?
    const { seenMessages } = await this.fetchDocumentMetadata(key);
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
      update: encodeEncryptedUpdateMessages(updates),
      stateVector: encryptedStateVector,
    };
  }
}
