import { Observable } from "teleportal";
import type { Message, Update } from "teleportal/protocol";
import type * as Y from "yjs";
import {
  DecodedEncryptedStateVector,
  DecodedEncryptedSyncStep2,
  decodeFromSyncStep2,
  EncryptedMessageId,
  EncryptedStateVector,
  EncryptedSyncStep2,
  EncryptedUpdateMessage,
} from "./encoding";
import type {
  ClientId,
  LamportClockId,
  LamportClockValue,
} from "./lamport-clock";
import { LamportClock } from "./lamport-clock";
import {
  getDecodedStateVector,
  getDecodedSyncStep2,
  getEncryptedStateVector,
  getEncryptedSyncStep2,
  SeenMessageMapping,
} from "./sync";

export abstract class EncryptionClient extends Observable<{
  "node-added": (node: EncryptedUpdateMessage) => void;
  "update-seen-messages": (seenMessages: SeenMessageMapping) => void;
}> {
  /**
   * A {@link LamportClock} to keep track of the message order
   */
  private clock: LamportClock;

  /**
   * A mapping of seen messages by their {@link ClientId} to a mapping of {@link Counter} to their {@link EncryptedMessageId}
   */
  private seenMessages: SeenMessageMapping = {};

  constructor(
    public document: string,
    public key: CryptoKey,
    private getEncryptedMessageUpdate: (
      messageId: EncryptedMessageId,
    ) => Promise<Update>,
    clientId: ClientId,
  ) {
    super();
    this.clock = new LamportClock(clientId);
  }

  /**
   * Returns a serialized version of the seen messages by their {@link LamportClockId} to their {@link EncryptedMessageId}
   */
  public getSeenMessages(): SeenMessageMapping {
    return this.seenMessages;
  }

  /**
   * Loads the seen messages from a serialized version of the seen messages by their {@link LamportClockId} to their {@link EncryptedMessageId}
   */
  public async loadSeenMessages(
    seenMessages: SeenMessageMapping,
  ): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const [clientId, messages] of Object.entries(seenMessages)) {
      for (const [counter, messageId] of Object.entries(messages)) {
        promises.push(
          this.getEncryptedMessageUpdate(messageId).then((update) => {
            this.createMessageNode(messageId, update, [
              parseInt(clientId),
              parseInt(counter),
            ]);
          }),
        );
      }
    }
    await Promise.all(promises);
  }

  public async addMessage(message: Message<any>): Promise<undefined> {
    if (message.document !== this.document) {
      // no-op, we don't care about other documents
      return;
    }
    if (
      !(
        message.type === "doc" &&
        (message.payload.type === "sync-step-2" ||
          message.payload.type === "update")
      )
    ) {
      // no-op, we only care about updates and sync-step-2 messages
      return;
    }

    if (message.payload.type === "update") {
      this.createMessageNode(message.id, message.payload.update);
    } else if (message.payload.type === "sync-step-2") {
      const decodedSyncStep2 = decodeFromSyncStep2(message.payload.update);
      for (const message of decodedSyncStep2.messages) {
        this.createMessageNode(message.id, message.payload, message.timestamp);
      }
    }
  }

  private createMessageNode(
    messageId: EncryptedMessageId,
    payload: Update,
    timestamp: LamportClockValue | null = null,
  ): EncryptedUpdateMessage {
    if (timestamp === null) {
      timestamp = this.clock.tick();
    } else {
      this.clock.receive(timestamp);
    }

    const [clientId, counter] = timestamp;
    if (!this.seenMessages[clientId]) {
      this.seenMessages[clientId] = {};
    }
    this.seenMessages[clientId][counter] = messageId;
    this.call("update-seen-messages", this.getSeenMessages());

    const node = EncryptedUpdateMessage.create(messageId, timestamp, payload);

    this.call("node-added", node);

    return node;
  }

  /**
   * Returns the {@link DecodedEncryptedStateVector} of the client.
   */
  public getDecodedStateVector(): DecodedEncryptedStateVector {
    return getDecodedStateVector(this.getSeenMessages());
  }

  /**
   * Returns the {@link EncryptedStateVector} of the client.
   */
  public getEncryptedStateVector(): EncryptedStateVector {
    return getEncryptedStateVector(this.getSeenMessages());
  }

  /**
   * Given a {@link DecodedEncryptedStateVector} of the other client,
   * returns a {@link DecodedEncryptedSyncStep2} of the messages that the other client has not seen yet.
   */
  public async getDecodedSyncStep2(
    syncStep1: DecodedEncryptedStateVector = { clocks: new Map() },
  ): Promise<DecodedEncryptedSyncStep2> {
    return getDecodedSyncStep2(
      this.getSeenMessages(),
      this.getEncryptedMessageUpdate,
      syncStep1,
    );
  }

  /**
   * Given a {@link DecodedEncryptedStateVector} of the other client,
   * returns a {@link EncryptedSyncStep2} of the messages that the other client has not seen yet.
   */
  public async getEncryptedSyncStep2(
    syncStep1: DecodedEncryptedStateVector = { clocks: new Map() },
  ): Promise<EncryptedSyncStep2> {
    return getEncryptedSyncStep2(
      this.getSeenMessages(),
      this.getEncryptedMessageUpdate,
      syncStep1,
    );
  }
}
