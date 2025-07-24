import { uuidv4 } from "lib0/random";
import type { PubSub, StateVector } from "teleportal";
import {
  decodeMessage,
  DocMessage,
  getEmptyStateVector,
  getEmptyUpdate,
  Observable,
  type Message,
  type ServerContext,
  type Update,
} from "teleportal";
import type { DocumentStorage } from "teleportal/storage";
import * as Y from "yjs";

import {
  decodeFauxStateVector,
  decodeFauxUpdateList,
  encodeFauxUpdateList,
  getEmptyFauxUpdateList,
} from "teleportal/protocol/encryption";
import type { Client } from "./client";
import type { Logger } from "./logger";

/**
 * The Document class represents a document in the server.
 *
 * It is responsible for managing the clients subscribed to the document,
 * and the storage of the document.
 *
 */
export class Document<Context extends ServerContext> extends Observable<{
  destroy: (document: Document<Context>) => void;
  "client-connected": (client: Client<Context>) => void;
  "client-disconnected": (client: Client<Context>) => void;
  "no-clients": (document: Document<Context>) => void;
  "client-reconnected": (document: Document<Context>) => void;
  broadcast: (message: Message<Context>) => void;
}> {
  public readonly id: string;
  private readonly uuid = "server-document-" + uuidv4();
  public readonly name: string;
  public logger: Logger;
  public readonly clients = new Set<Client<Context>>();
  private readonly storage: DocumentStorage;
  private readonly pubSub: PubSub;
  private readonly unsubscribe: Promise<() => Promise<void>>;
  #destroyed = false;

  constructor({
    name,
    id,
    logger,
    storage,
    pubSub,
  }: {
    name: string;
    id: string;
    logger: Logger;
    storage: DocumentStorage;
    pubSub: PubSub;
  }) {
    super();
    this.name = name;
    this.id = id;
    this.logger = logger
      .child()
      .withContext({ name: "document", documentId: id, document: name });
    this.storage = storage;
    this.pubSub = pubSub;
    this.unsubscribe = pubSub.subscribe(
      `document/${id}`,
      async (message, sourceId) => {
        if (sourceId === this.uuid) {
          this.logger
            .withMetadata({
              sourceId,
              documentId: this.id,
            })
            .trace("received message from self, skipping");
          return;
        }
        const rawMessage = decodeMessage(message);
        const room = this.getRoom();
        if (
          this.id !==
          Document.getDocumentId({
            document: rawMessage.document,
            context: {
              userId: rawMessage.context.userId,
              clientId: rawMessage.context.clientId,
              room,
            },
          })
        ) {
          this.logger
            .withMetadata({
              sourceId,
              messageId: rawMessage.id,
              documentId: this.id,
              document: rawMessage.document,
            })
            .trace("received message for wrong document, skipping");
          return;
        }
        // TODO this is a hack to get the room context for the message
        // Need to think of a better way to do this
        Object.assign(rawMessage.context, {
          room,
        });
        await this.handleMessage(rawMessage);
      },
    );
  }

  /**
   * Document ID format: "room/document" or "document"
   * This method returns the room part of the document ID
   */
  public getRoom() {
    const lastSlashIndex = this.id.lastIndexOf("/");
    if (lastSlashIndex !== -1) {
      return this.id.slice(0, lastSlashIndex);
    }
    return "";
  }

  /**
   * Get the encrypted property from storage
   */
  public get encrypted(): boolean {
    return this.storage.encrypted;
  }

  /**
   * Fetch data from storage
   */
  public async fetch() {
    return await this.storage.fetch(this.id);
  }

  /**
   * Write data to storage
   */
  public async write(update: Update) {
    return await this.storage.write(this.id, update);
  }

  /**
   * Broadcast a message to all clients of the current document and other server instances.
   */
  public async broadcast(
    message: Message<Context>,
    excludeClientId = message.context.clientId,
  ) {
    if (Document.getDocumentId(message) !== this.id) {
      throw new Error("Received message for wrong document", {
        cause: {
          messageId: message.id,
          documentId: this.id,
        },
      });
    }
    const logger = this.logger.child().withContext({
      documentId: this.id,
      messageId: message.id,
    });

    logger.trace("broadcasting message to all clients");

    for (const client of this.clients) {
      if (client.id !== excludeClientId) {
        logger
          .withMetadata({ targetClientId: client.id })
          .trace("writing message to client");
        await client.send(message);
      }
    }

    await this.call("broadcast", message);
    await this.pubSub.publish(
      `document/${this.id}`,
      message.encoded,
      this.uuid,
    );
  }

  /**
   * Check if a client is subscribed to this document
   */
  public hasClient(clientId: string): boolean {
    return this.clients.values().some((client) => client.id === clientId);
  }

  public getClient(clientId: string): Client<Context> | undefined {
    return this.clients.values().find((client) => client.id === clientId);
  }

  /**
   * Get all client IDs subscribed to this document
   */
  public getClientIds(): string[] {
    return Array.from(this.clients.values().map((client) => client.id));
  }

  /**
   * Get the document ID from a message.
   */
  static getDocumentId(
    message: Pick<Message<ServerContext>, "context" | "document">,
  ) {
    return message.context.room
      ? message.context.room + "/" + message.document
      : message.document;
  }

  /**
   * Add a client to this document
   */
  public addClient(client: Client<Context>): void {
    this.clients.add(client);
    this.logger
      .withMetadata({ clientId: client.id })
      .trace("client added to document");

    this.call("client-connected", client);
  }

  /**
   * Remove a client from this document
   */
  public removeClient(client: Client<Context>): void {
    this.clients.delete(client);
    this.logger
      .withMetadata({ clientId: client.id })
      .trace("client removed from document");

    this.call("client-disconnected", client);
  }

  /**
   * Get the number of clients connected to this document
   */
  public getClientCount(): number {
    return this.clients.size;
  }

  public async handleMessage(
    message: Message<Context>,
    client = this.getClient(message.context.clientId),
  ) {
    const logger = this.logger.child().withContext({
      name: "message-handler",
      context: message.context,
      messageId: message.id,
      payloadType: message.payload.type,
    });

    try {
      logger.trace("processing message");

      // Validate encryption consistency
      if (message.encrypted !== this.encrypted) {
        throw new Error(
          "Message encryption and document encryption are mismatched",
          {
            cause: {
              messageEncrypted: message.encrypted,
              documentEncrypted: this.encrypted,
            },
          },
        );
      }

      const strategy = message.encrypted
        ? new EncryptedMessageStrategy<Context>()
        : new ClearTextMessageStrategy<Context>();

      switch (message.type) {
        case "doc":
          switch (message.payload.type) {
            case "sync-step-1":
              if (!client) {
                logger.trace("client not found, skipping sync-step-1");
                return;
              }

              const { update, stateVector } = await strategy.fetchUpdate(
                this,
                message,
              );

              logger.trace("sending sync-step-2");
              await client.send(
                new DocMessage(
                  this.name,
                  {
                    type: "sync-step-2",
                    update,
                  },
                  message.context,
                  this.encrypted,
                ),
              );
              logger.trace("sync-step-2 sent");

              // TODO not implemented for encrypted documents
              if (!this.encrypted) {
                logger.trace("sending sync-step-1");
                await client.send(
                  new DocMessage(
                    this.name,
                    { type: "sync-step-1", sv: stateVector },
                    message.context,
                    this.encrypted,
                  ),
                );
                logger.trace("sync-step-1 sent");
              } else {
                // since we're encrypted, we can't send a sync-step-1, so we send a sync-done
                logger.trace("sending sync-done (encrypted)");
                await client.send(
                  new DocMessage(
                    this.name,
                    {
                      type: "sync-done",
                    },
                    message.context,
                    this.encrypted,
                  ),
                );
                logger.trace("sync-done sent");
              }
              return;
            case "update":
              logger.trace("broadcasting update");
              await this.broadcast(message, client?.id);
              logger.trace("writing update");
              await this.write(message.payload.update);
              logger.trace("update written");
              return;
            case "sync-step-2":
              logger.trace("broadcasting sync-step-2");
              await this.broadcast(message, client?.id);
              logger.trace("writing update");
              await this.write(message.payload.update);
              logger.trace("update written");

              if (!client) {
                logger.trace("client not found, skipping sync-done");
                return;
              }
              logger.trace("sending sync-done (clear text)");
              await client.send(
                new DocMessage(
                  this.name,
                  {
                    type: "sync-done",
                  },
                  message.context,
                  this.encrypted,
                ),
              );
              logger.trace("sync-done sent");
              return;
            case "sync-done":
            case "auth-message":
              // Sync-done & auth-message messages are informational from client, no action needed
              return;
            default:
              throw new Error("unknown message type");
          }
        default:
          logger.trace("broadcasting message");
          // Broadcast the message to all clients
          await this.broadcast(message, client?.id);
          logger.trace("message broadcasted");
      }

      logger.trace("message processed successfully");
    } catch (e) {
      logger.withError(e).error("Failed to handle message");
      throw e;
    }
  }

  /**
   * Destroy the document.
   */
  public async destroy() {
    if (this.#destroyed) {
      return;
    }

    this.#destroyed = true;

    this.logger.trace("destroying document");

    // Emit destroy event
    try {
      await this.call("destroy", this);
    } catch (e) {
      this.logger.withError(e).error("Failed to emit destroy event");
    }

    // Unsubscribe from pubsub
    this.logger.trace("unsubscribing from pubsub");
    try {
      await (
        await this.unsubscribe
      )();
      this.logger.trace("unsubscribed from pubsub");
    } catch (e) {
      this.logger.withError(e).error("Failed to unsubscribe from pubsub");
    }

    // Unload storage
    this.logger.trace("unloading storage");
    try {
      await this.storage.unload(this.id);
      this.logger.trace("unloading storage done");
    } catch (e) {
      this.logger.withError(e).error("Failed to unload storage");
    }

    // Unsubscribe all clients
    this.logger.trace("unsubscribing clients");
    for (const client of this.clients) {
      try {
        client.unsubscribeFromDocument(this);
      } catch (e) {
        this.logger
          .withError(e)
          .error("Failed to unsubscribe client from document");
      }
    }
    this.logger.trace("clients unsubscribed");

    this.clients.clear();
    this.logger.trace("clients cleared");

    super.destroy();
    this.logger.trace("document destroyed");
  }
}

/**
 * Strategy interface for handling different message types
 */
interface MessageStrategy<Context extends ServerContext> {
  fetchUpdate(
    document: Document<Context>,
    message: DocMessage<Context>,
  ): Promise<{ update: Update; stateVector: StateVector }>;
}

/**
 * Strategy for handling clear text messages
 */
class ClearTextMessageStrategy<Context extends ServerContext>
  implements MessageStrategy<Context>
{
  async fetchUpdate(
    document: Document<Context>,
    message: DocMessage<Context>,
  ): Promise<{ update: Update; stateVector: StateVector }> {
    const { update, stateVector } = (await document.fetch()) ?? {
      update: getEmptyUpdate(),
      stateVector: getEmptyStateVector(),
    };

    // Type guard to ensure this is a sync-step-1 message
    if (message.type !== "doc" || message.payload.type !== "sync-step-1") {
      throw new Error("Expected sync-step-1 message");
    }

    return {
      update: Y.diffUpdateV2(update, message.payload.sv) as Update,
      stateVector,
    };
  }
}

/**
 * Strategy for handling encrypted messages
 */
class EncryptedMessageStrategy<Context extends ServerContext>
  implements MessageStrategy<Context>
{
  async fetchUpdate(
    document: Document<Context>,
    message: DocMessage<Context>,
  ): Promise<{ update: Update; stateVector: StateVector }> {
    const { update, stateVector } = (await document.fetch()) ?? {
      update: getEmptyFauxUpdateList(),
      stateVector: getEmptyStateVector(),
    };

    // Type guard to ensure this is a sync-step-1 message
    if (message.payload.type !== "sync-step-1") {
      throw new Error("Expected sync-step-1 message");
    }

    const fauxStateVector = decodeFauxStateVector(message.payload.sv);
    const updates = decodeFauxUpdateList(update);
    const updateIndex = updates.findIndex(
      (update) => update.messageId === fauxStateVector.messageId,
    );

    // Pick the updates that the client doesn't have
    const sendUpdates = updates.slice(
      0,
      // Didn't find any? Send them all
      updateIndex === -1 ? updates.length : updateIndex,
    );

    return {
      update: encodeFauxUpdateList(sendUpdates),
      stateVector,
    };
  }
}
