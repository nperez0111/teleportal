import { toBase64 } from "lib0/buffer";
import { digest } from "lib0/hash/sha256";
import type { Message } from "../protocol/message-types";

/**
 * Represents a message identifier in the encryption state vector
 */
export type MessageId = string;

/**
 * A compressed representation of the state vector using ranges
 */
export type CompressedStateVector = {
  /** Array of message ID ranges that have been received */
  ranges: Array<{ start: MessageId; end: MessageId }>;
  /** Individual message IDs that don't fit into ranges */
  individual: MessageId[];
};

/**
 * Encryption state vector that tracks all messages received for a document
 */
export class EncryptionStateVector {
  private messageIds: Set<MessageId> = new Set();
  private messageOrder: MessageId[] = [];
  private lastSyncedMessages: Map<string, MessageId> = new Map();

  constructor(
    /** The document this state vector belongs to */
    public readonly document: string,
    /** Optional initial state */
    initialState?: {
      messageIds?: MessageId[];
      lastSyncedMessages?: Map<string, MessageId>;
    }
  ) {
    if (initialState?.messageIds) {
      this.messageIds = new Set(initialState.messageIds);
      this.messageOrder = [...initialState.messageIds];
    }
    if (initialState?.lastSyncedMessages) {
      this.lastSyncedMessages = new Map(initialState.lastSyncedMessages);
    }
  }

  /**
   * Add a message to the state vector
   */
  addMessage(message: Message<any>): void {
    if (message.document !== this.document) {
      throw new Error(`Message document ${message.document} does not match state vector document ${this.document}`);
    }

    const messageId = message.id;
    if (!this.messageIds.has(messageId)) {
      this.messageIds.add(messageId);
      this.messageOrder.push(messageId);
    }
  }

  /**
   * Check if a message has been received
   */
  hasMessage(messageId: MessageId): boolean {
    return this.messageIds.has(messageId);
  }

  /**
   * Get all message IDs in the order they were received
   */
  getAllMessageIds(): MessageId[] {
    return [...this.messageOrder];
  }

  /**
   * Get messages that are newer than the provided state vector
   */
  getMessagesSince(otherStateVector: EncryptionStateVector): MessageId[] {
    const newMessages: MessageId[] = [];
    for (const messageId of this.messageOrder) {
      if (!otherStateVector.hasMessage(messageId)) {
        newMessages.push(messageId);
      }
    }
    return newMessages;
  }

  /**
   * Get messages that are newer than the provided message IDs
   */
  getMessagesSinceIds(knownMessageIds: MessageId[]): MessageId[] {
    const knownSet = new Set(knownMessageIds);
    return this.messageOrder.filter(id => !knownSet.has(id));
  }

  /**
   * Update the last synced message for a client
   */
  updateLastSyncedMessage(clientId: string, messageId: MessageId): void {
    if (!this.messageIds.has(messageId)) {
      throw new Error(`Message ID ${messageId} not found in state vector`);
    }
    this.lastSyncedMessages.set(clientId, messageId);
  }

  /**
   * Get the last synced message for a client
   */
  getLastSyncedMessage(clientId: string): MessageId | undefined {
    return this.lastSyncedMessages.get(clientId);
  }

  /**
   * Get messages that a client hasn't seen yet
   */
  getUnseenMessages(clientId: string): MessageId[] {
    const lastSynced = this.lastSyncedMessages.get(clientId);
    if (!lastSynced) {
      return [...this.messageOrder];
    }

    const lastSyncedIndex = this.messageOrder.indexOf(lastSynced);
    if (lastSyncedIndex === -1) {
      return [...this.messageOrder];
    }

    return this.messageOrder.slice(lastSyncedIndex + 1);
  }

  /**
   * Compress the state vector for efficient transmission
   * This creates ranges of consecutive message IDs to reduce size
   */
  compress(): CompressedStateVector {
    if (this.messageOrder.length === 0) {
      return { ranges: [], individual: [] };
    }

    // Sort message IDs for range detection
    const sortedIds = [...this.messageOrder].sort();
    const ranges: Array<{ start: MessageId; end: MessageId }> = [];
    const individual: MessageId[] = [];

    let currentRange: { start: MessageId; end: MessageId } | null = null;
    let consecutiveCount = 1;

    for (let i = 0; i < sortedIds.length; i++) {
      const current = sortedIds[i];
      const next = sortedIds[i + 1];

      if (next && this.areConsecutive(current, next)) {
        if (!currentRange) {
          currentRange = { start: current, end: current };
        }
        currentRange.end = next;
        consecutiveCount++;
      } else {
        if (currentRange && consecutiveCount >= 3) {
          ranges.push(currentRange);
        } else if (currentRange) {
          // Add individual IDs if range is too small
          for (let j = i - consecutiveCount + 1; j <= i; j++) {
            individual.push(sortedIds[j]);
          }
        } else {
          individual.push(current);
        }
        currentRange = null;
        consecutiveCount = 1;
      }
    }

    return { ranges, individual };
  }

  /**
   * Create a state vector from a compressed representation
   */
  static fromCompressed(
    document: string,
    compressed: CompressedStateVector
  ): EncryptionStateVector {
    const messageIds: MessageId[] = [];

    // Add individual message IDs
    messageIds.push(...compressed.individual);

    // Expand ranges
    for (const range of compressed.ranges) {
      const expandedIds = this.expandRange(range.start, range.end);
      messageIds.push(...expandedIds);
    }

    return new EncryptionStateVector(document, { messageIds });
  }

  /**
   * Serialize the state vector to a string for storage/transmission
   */
  serialize(): string {
    const data = {
      document: this.document,
      messageIds: this.messageOrder,
      lastSyncedMessages: Object.fromEntries(this.lastSyncedMessages),
    };
    return toBase64(new TextEncoder().encode(JSON.stringify(data)));
  }

  /**
   * Deserialize a state vector from a string
   */
  static deserialize(serialized: string): EncryptionStateVector {
    const data = JSON.parse(new TextDecoder().decode(
      new Uint8Array(Array.from(atob(serialized), c => c.charCodeAt(0)))
    ));
    return new EncryptionStateVector(data.document, {
      messageIds: data.messageIds,
      lastSyncedMessages: new Map(Object.entries(data.lastSyncedMessages)),
    });
  }

  /**
   * Merge another state vector into this one
   */
  merge(other: EncryptionStateVector): void {
    if (other.document !== this.document) {
      throw new Error(`Cannot merge state vectors for different documents`);
    }

    for (const messageId of other.messageOrder) {
      if (!this.messageIds.has(messageId)) {
        this.messageIds.add(messageId);
        this.messageOrder.push(messageId);
      }
    }

    // Merge last synced messages
    for (const [clientId, messageId] of other.lastSyncedMessages) {
      this.lastSyncedMessages.set(clientId, messageId);
    }
  }

  /**
   * Get the current size of the state vector
   */
  size(): number {
    return this.messageIds.size;
  }

  /**
   * Clear old messages to prevent unbounded growth
   * Keeps only the last `maxMessages` messages
   */
  prune(maxMessages: number): void {
    if (this.messageOrder.length <= maxMessages) {
      return;
    }

    const messagesToRemove = this.messageOrder.length - maxMessages;
    const removedMessages = this.messageOrder.splice(0, messagesToRemove);

    for (const messageId of removedMessages) {
      this.messageIds.delete(messageId);
    }
  }

  /**
   * Helper method to check if two message IDs are consecutive
   * This is a simplified implementation - in practice, you might want
   * to use a more sophisticated approach based on your message ID structure
   */
  private areConsecutive(id1: MessageId, id2: MessageId): boolean {
    // For hash-based IDs, this is always false
    // This method exists for potential future optimization with sequential IDs
    return false;
  }

  /**
   * Helper method to expand a range of message IDs
   */
  private static expandRange(start: MessageId, end: MessageId): MessageId[] {
    // For hash-based IDs, ranges don't apply
    // This method exists for potential future optimization with sequential IDs
    return [start, end];
  }
}

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
  updateLastSyncedMessage(document: string, clientId: string, messageId: MessageId): void {
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
      ])
    );
    return toBase64(new TextEncoder().encode(JSON.stringify(data)));
  }

  /**
   * Deserialize state vectors from a string
   */
  static deserialize(serialized: string): EncryptionStateVectorManager {
    const manager = new EncryptionStateVectorManager();
    const data = JSON.parse(new TextDecoder().decode(
      new Uint8Array(Array.from(atob(serialized), c => c.charCodeAt(0)))
    ));
    
    for (const [document, serializedSV] of Object.entries(data)) {
      const stateVector = EncryptionStateVector.deserialize(serializedSV as string);
      manager.stateVectors.set(document, stateVector);
    }
    
    return manager;
  }
}