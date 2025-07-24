import { toBase64 } from "lib0/buffer";
import type { Message } from "teleportal/protocol";
import { EncryptionStateVector, type MessageId } from "./state-vector";

/**
 * Manager for encryption state vectors across multiple documents
 */
export class EncryptionStateVectorManager {
  private stateVectors: Map<string, EncryptionStateVector> = new Map();

  /**
   * Get or create a state vector for a document
   */
  getStateVector(document: string): EncryptionStateVector {
    if (!this.stateVectors.has(document)) {
      this.stateVectors.set(document, new EncryptionStateVector(document));
    }
    return this.stateVectors.get(document)!;
  }

  /**
   * Add a message to the appropriate state vector
   */
  addMessage(message: Message<any>): void {
    const stateVector = this.getStateVector(message.document);
    stateVector.addMessage(message);
  }

  /**
   * Get messages that a client hasn't seen for a specific document
   */
  getUnseenMessages(document: string, clientId: string): MessageId[] {
    const stateVector = this.stateVectors.get(document);
    if (!stateVector) {
      return [];
    }
    return stateVector.getUnseenMessages(clientId);
  }

  /**
   * Update the last synced message for a client and document
   */
  updateLastSyncedMessage(
    document: string,
    clientId: string,
    messageId: MessageId,
  ): void {
    const stateVector = this.getStateVector(document);
    stateVector.updateLastSyncedMessage(clientId, messageId);
  }

  /**
   * Get all state vectors
   */
  getAllStateVectors(): Map<string, EncryptionStateVector> {
    return new Map(this.stateVectors);
  }

  /**
   * Serialize all state vectors
   */
  serialize(): string {
    const data = Object.fromEntries(
      Array.from(this.stateVectors.entries()).map(([doc, sv]) => [
        doc,
        sv.serialize(),
      ]),
    );
    return toBase64(new TextEncoder().encode(JSON.stringify(data)));
  }

  /**
   * Deserialize state vectors from a string
   */
  static deserialize(serialized: string): EncryptionStateVectorManager {
    const manager = new EncryptionStateVectorManager();
    const data = JSON.parse(
      new TextDecoder().decode(
        new Uint8Array(Array.from(atob(serialized), (c) => c.charCodeAt(0))),
      ),
    );

    for (const [document, serializedSV] of Object.entries(data)) {
      const stateVector = EncryptionStateVector.deserialize(
        serializedSV as string,
      );
      manager.stateVectors.set(document, stateVector);
    }

    return manager;
  }
}
