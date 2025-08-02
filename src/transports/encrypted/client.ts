import { toBase64 } from "lib0/buffer";
import { digest } from "lib0/hash/sha256";
import { ClientContext, Observable } from "teleportal";
import {
  DecryptedUpdate,
  decryptUpdate as defaultDecryptUpdate,
  encryptUpdate as defaultEncryptUpdate,
  EncryptedUpdate,
} from "teleportal/encryption-key";
import {
  AwarenessMessage,
  AwarenessUpdateMessage,
  DocMessage,
  Message,
  Update,
} from "teleportal/protocol";
import type {
  ClientId,
  DecodedEncryptedStateVector,
  DecodedEncryptedSyncStep2,
  EncryptedMessageId,
  EncryptedStateVector,
  EncryptedSyncStep2,
  EncryptedUpdatePayload,
  LamportClockId,
  LamportClockValue,
  SeenMessageMapping,
} from "teleportal/protocol/encryption";
import {
  DecodedEncryptedUpdatePayload,
  decodeEncryptedUpdate,
  decodeFromStateVector,
  decodeFromSyncStep2,
  encodeEncryptedUpdateMessages,
  getDecodedStateVector,
  getDecodedSyncStep2,
  getEncryptedStateVector,
  getEncryptedSyncStep2,
  LamportClock,
} from "teleportal/protocol/encryption";
import {
  applyAwarenessUpdate,
  Awareness,
  encodeAwarenessUpdate,
} from "y-protocols/awareness.js";
import * as Y from "yjs";
import {
  getSyncTransactionOrigin,
  YDocSinkHandler,
  YDocSourceHandler,
} from "../ydoc";

export class EncryptionClient
  extends Observable<{
    "update-seen-messages": (seenMessages: SeenMessageMapping) => void;
    "seen-update": (node: DecodedEncryptedUpdatePayload) => void;
    "loaded-seen-messages": () => void;
  }>
  implements YDocSinkHandler, YDocSourceHandler
{
  /**
   * A {@link LamportClock} to keep track of the message order
   */
  private clock: LamportClock;

  /**
   * A mapping of seen messages by their {@link ClientId} to a mapping of {@link Counter} to their {@link EncryptedMessageId}
   */
  public seenMessages: SeenMessageMapping = {};

  public document: string;
  public ydoc: Y.Doc;
  public awareness: Awareness;
  public key: CryptoKey;
  public getEncryptedMessageUpdate: (
    messageId: EncryptedMessageId,
  ) => Promise<EncryptedUpdate>;
  #decryptUpdate: (
    key: CryptoKey,
    encryptedUpdate: EncryptedUpdate,
  ) => Promise<DecryptedUpdate>;
  #encryptUpdate: (
    key: CryptoKey,
    update: DecryptedUpdate,
  ) => Promise<EncryptedUpdate>;

  constructor({
    document,
    ydoc,
    awareness,
    key,
    getEncryptedMessageUpdate,
    decryptUpdate,
    encryptUpdate,
  }: {
    document: string;
    ydoc?: Y.Doc;
    awareness?: Awareness;
    key: CryptoKey;
    getEncryptedMessageUpdate: (
      messageId: EncryptedMessageId,
    ) => Promise<EncryptedUpdate>;
    decryptUpdate?: (
      key: CryptoKey,
      encryptedUpdate: EncryptedUpdate,
    ) => Promise<DecryptedUpdate>;
    encryptUpdate?: (
      key: CryptoKey,
      update: DecryptedUpdate,
    ) => Promise<EncryptedUpdate>;
  }) {
    super();
    this.ydoc = ydoc ?? new Y.Doc();
    this.awareness = awareness ?? new Awareness(this.ydoc);
    this.clock = new LamportClock(this.awareness.clientID);
    this.document = document;
    this.key = key;
    this.getEncryptedMessageUpdate = getEncryptedMessageUpdate;
    this.#decryptUpdate = decryptUpdate ?? defaultDecryptUpdate;
    this.#encryptUpdate = encryptUpdate ?? defaultEncryptUpdate;
  }

  /**
   * Encrypts a {@link DecryptedUpdate} using the {@link CryptoKey}.
   */
  public encryptUpdate(update: DecryptedUpdate): Promise<EncryptedUpdate> {
    return this.#encryptUpdate(this.key, update);
  }

  /**
   * Decrypts an {@link EncryptedUpdate} using the {@link CryptoKey}.
   */
  public decryptUpdate(
    encryptedUpdate: EncryptedUpdate,
  ): Promise<DecryptedUpdate> {
    return this.#decryptUpdate(this.key, encryptedUpdate);
  }
  private loadedSeenMessages: boolean = false;

  /**
   * Loads the seen messages from a serialized version of the seen messages by their {@link LamportClockId} to their {@link EncryptedMessageId}
   */
  public async loadSeenMessages(
    seenMessages: SeenMessageMapping,
  ): Promise<void> {
    const promises: Promise<DecryptedUpdate>[] = [];
    for (const [clientId, messages] of Object.entries(seenMessages)) {
      for (const [counter, messageId] of Object.entries(messages)) {
        promises.push(
          this.getEncryptedMessageUpdate(messageId)
            .then((update) => {
              return this.createMessageNode(messageId, update, [
                parseInt(clientId),
                parseInt(counter),
              ]).payload;
            })
            .then((update) => this.decryptUpdate(update)),
        );
      }
    }
    this.applyUpdates(await Promise.all(promises));
    this.loadedSeenMessages = true;
    this.call("loaded-seen-messages");
  }

  /**
   * Applies a list of {@link DecryptedUpdate}s to the {@link Y.Doc}.
   */
  private applyUpdates(updates: DecryptedUpdate[]): void {
    this.ydoc.transact((tr) => {
      for (const update of updates) {
        Y.applyUpdateV2(tr.doc, update, getSyncTransactionOrigin(this.ydoc));
      }
    });
  }

  public async start(): Promise<Message> {
    if (!this.loadedSeenMessages) {
      await new Promise<void>((resolve) => {
        this.once("loaded-seen-messages", resolve);
      });
    }
    return new DocMessage(
      this.document,
      {
        type: "sync-step-1",
        sv: this.getEncryptedStateVector(),
      },
      {
        clientId: this.awareness.clientID.toString(),
      },
      true,
    );
  }

  /**
   * Handles an {@link EncryptedStateVector} by getting the {@link EncryptedSyncStep2} and returning a {@link DocMessage} with the {@link EncryptedSyncStep2}.
   */
  public async handleSyncStep1(
    syncStep1: EncryptedStateVector,
  ): Promise<DocMessage<ClientContext>> {
    const decodedEncryptedStateVector = decodeFromStateVector(syncStep1);
    const encryptedSyncStep2 = await this.getEncryptedSyncStep2(
      decodedEncryptedStateVector,
    );

    return new DocMessage(
      this.document,
      {
        type: "sync-step-2",
        update: encryptedSyncStep2,
      },
      {
        clientId: this.awareness.clientID.toString(),
      },
      true,
    );
  }

  /**
   * Handles an {@link EncryptedSyncStep2} by decrypting the updates and applying them to the {@link Y.Doc}.
   */
  public async handleSyncStep2(syncStep2: EncryptedSyncStep2): Promise<void> {
    const decodedSyncStep2 = decodeFromSyncStep2(syncStep2);
    const updates = await Promise.all(
      decodedSyncStep2.messages
        .map(
          (message) =>
            this.createMessageNode(
              message.id,
              message.payload,
              message.timestamp,
            ).payload,
        )
        .map(async (update) => this.decryptUpdate(update)),
    );
    this.applyUpdates(updates);
  }

  /**
   * Handles an {@link EncryptedUpdatePayload} by decrypting the updates and applying them to the {@link Y.Doc}.
   */
  public async handleUpdate(payload: EncryptedUpdatePayload): Promise<void> {
    const messages = decodeEncryptedUpdate(payload);
    const updates = await Promise.all(
      messages
        .map(
          (message) =>
            this.createMessageNode(
              message.id,
              message.payload,
              message.timestamp,
            ).payload,
        )
        .map(async (update) => this.decryptUpdate(update)),
    );
    this.applyUpdates(updates);
  }

  /**
   * Handles an {@link AwarenessUpdateMessage} by decrypting it and applying it to the {@link Awareness}.
   */
  public async handleAwarenessUpdate(
    update: AwarenessUpdateMessage,
  ): Promise<void> {
    applyAwarenessUpdate(
      this.awareness,
      await this.decryptUpdate(update),
      getSyncTransactionOrigin(this.ydoc),
    );
  }

  /**
   * Handles an {@link AwarenessRequestMessage} by encrypting the {@link AwarenessUpdateMessage} and returning a {@link AwarenessMessage}.
   */
  public async handleAwarenessRequest(): Promise<
    AwarenessMessage<ClientContext>
  > {
    return new AwarenessMessage(
      this.document,
      {
        type: "awareness-update",
        update: (await this.encryptUpdate(
          encodeAwarenessUpdate(this.awareness, [this.awareness.clientID]),
        )) as AwarenessUpdateMessage,
      },
      {
        clientId: this.awareness.clientID.toString(),
      },
      true,
    );
  }

  /**
   * Tracks an {@link Update} by encrypting it and creating a {@link DecodedEncryptedUpdatePayload}.
   * This tracks the update in the {@link seenMessages}
   */
  private async trackUpdate(payload: Update): Promise<EncryptedUpdatePayload> {
    const encryptedUpdate = await this.encryptUpdate(payload);
    const messageId = toBase64(digest(encryptedUpdate));
    const decodedUpdate = this.createMessageNode(messageId, encryptedUpdate);

    return encodeEncryptedUpdateMessages([decodedUpdate]);
  }

  /**
   * Handles an {@link Update} by encrypting it and returning a {@link DocMessage}.
   * This tracks the update in the {@link seenMessages}
   */
  public async onUpdate(update: Update): Promise<Message> {
    const encryptedUpdate = await this.trackUpdate(update);
    return new DocMessage(
      this.document,
      {
        type: "update",
        update: encryptedUpdate,
      },
      {
        clientId: this.awareness.clientID.toString(),
      },
      true,
    );
  }

  /**
   * Handles an {@link AwarenessUpdateMessage} by encrypting it and returning a {@link AwarenessMessage}.
   * This tracks the update in the {@link seenMessages}
   */
  public async onAwarenessUpdate(
    update: AwarenessUpdateMessage,
  ): Promise<Message> {
    const encryptedUpdate = await this.encryptUpdate(update);

    return new AwarenessMessage(
      this.document,
      {
        type: "awareness-update",
        update: encryptedUpdate as AwarenessUpdateMessage,
      },
      {
        clientId: this.awareness.clientID.toString(),
      },
      true,
    );
  }

  private createMessageNode(
    messageId: EncryptedMessageId,
    payload: EncryptedUpdate,
    timestamp?: LamportClockValue,
  ): DecodedEncryptedUpdatePayload {
    if (timestamp) {
      this.clock.receive(timestamp);
    } else {
      timestamp = this.clock.tick();
    }
    if (toBase64(digest(payload)) !== messageId) {
      throw new Error("Message ID mismatch");
    }

    const [clientId, counter] = timestamp;
    if (!this.seenMessages[clientId]) {
      this.seenMessages[clientId] = {};
    }
    this.seenMessages[clientId][counter] = messageId;
    this.call("update-seen-messages", this.seenMessages);
    const node = { id: messageId, timestamp, payload };

    this.call("seen-update", node);

    return node;
  }

  /**
   * Returns the {@link DecodedEncryptedStateVector} of the client.
   */
  private getDecodedStateVector(): DecodedEncryptedStateVector {
    return getDecodedStateVector(this.seenMessages);
  }

  /**
   * Returns the {@link EncryptedStateVector} of the client.
   */
  private getEncryptedStateVector(): EncryptedStateVector {
    return getEncryptedStateVector(this.seenMessages);
  }

  /**
   * Given a {@link DecodedEncryptedStateVector} of the other client,
   * returns a {@link DecodedEncryptedSyncStep2} of the messages that the other client has not seen yet.
   */
  private async getDecodedSyncStep2(
    syncStep1: DecodedEncryptedStateVector = { clocks: new Map() },
  ): Promise<DecodedEncryptedSyncStep2> {
    return getDecodedSyncStep2(
      this.seenMessages,
      this.getEncryptedMessageUpdate,
      syncStep1,
    );
  }

  /**
   * Given a {@link DecodedEncryptedStateVector} of the other client,
   * returns a {@link EncryptedSyncStep2} of the messages that the other client has not seen yet.
   */
  private async getEncryptedSyncStep2(
    syncStep1: DecodedEncryptedStateVector = { clocks: new Map() },
  ): Promise<EncryptedSyncStep2> {
    return getEncryptedSyncStep2(
      this.seenMessages,
      this.getEncryptedMessageUpdate,
      syncStep1,
    );
  }
}
