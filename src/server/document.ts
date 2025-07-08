import { ObservableV2 } from "lib0/observable";
import type { StateVector } from "teleportal";
import {
  DocMessage,
  getEmptyStateVector,
  getEmptyUpdate,
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
} from "../protocol/encryption/encoding";
import type { Client } from "./client";
import type { Logger } from "./logger";

/**
 * The Document class represents a document in the server.
 *
 * It is responsible for managing the clients subscribed to the document,
 * and the storage of the document.
 *
 */
export class Document<Context extends ServerContext> extends ObservableV2<{
  destroy: (document: Document<Context>) => void;
  "client-connected": (client: Client<Context>) => void;
  "client-disconnected": (client: Client<Context>) => void;
  broadcast: (message: Message<Context>) => void;
}> {
  public readonly id: string;
  public readonly name: string;
  public logger: Logger;
  public readonly clients = new Set<Client<Context>>();
  private readonly storage: DocumentStorage;

  constructor({
    name,
    id,
    logger,
    storage,
  }: {
    name: string;
    id: string;
    logger: Logger;
    storage: DocumentStorage;
  }) {
    super();
    this.name = name;
    this.id = id;
    this.logger = logger.withContext({ name: "document", documentId: id });
    this.storage = storage;
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
  public async broadcast(message: Message<Context>) {
    if (Document.getDocumentId(message) !== this.id) {
      throw new Error("Received message for wrong document", {
        cause: {
          messageId: message.id,
          documentId: this.id,
        },
      });
    }
    const logger = this.logger.withContext({
      documentId: this.id,
      messageId: message.id,
    });

    logger.trace("broadcasting message to all clients");

    for (const client of this.clients) {
      if (client.id !== message.context.clientId) {
        logger
          .withMetadata({ clientId: client.id })
          .trace("writing message to client");
        await client.send(message);
      }
    }

    this.emit("broadcast", [message]);
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
   * Create a document from a message.
   */
  static fromMessage(ctx: {
    message: Message<ServerContext>;
    logger: Logger;
    storage: DocumentStorage;
  }) {
    return new Document({
      id: Document.getDocumentId(ctx.message),
      name: ctx.message.document,
      logger: ctx.logger,
      storage: ctx.storage,
    });
  }

  /**
   * Add a client to this document
   */
  public addClient(client: Client<Context>): void {
    this.clients.add(client);
    this.logger
      .withMetadata({ clientId: client.id })
      .trace("client added to document");

    this.emit("client-connected", [client]);
  }

  /**
   * Remove a client from this document
   */
  public removeClient(client: Client<Context>): void {
    this.clients.delete(client);
    this.logger
      .withMetadata({ clientId: client.id })
      .trace("client removed from document");

    this.emit("client-disconnected", [client]);

    // If no clients remain, destroy the document
    if (this.clients.size === 0) {
      this.logger
        .withMetadata({ documentId: this.id })
        .trace("destroying document - no remaining clients");
      this.destroy();
    }
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
    const logger = this.logger
      .withContext({ name: "message-handler" })
      .withContext({
        context: message.context,
        document: message.document,
        documentId: this.id,
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

      console.log(message.encrypted, this.id);

      const strategy = message.encrypted
        ? new EncryptedMessageStrategy<Context>()
        : new ClearTextMessageStrategy<Context>();

      switch (message.type) {
        case "doc":
          switch (message.payload.type) {
            case "sync-step-1":
              if (!client) {
                throw new Error(`Client not found`, {
                  cause: { clientId: message.context.clientId },
                });
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
              } else {
                // since we're encrypted, we can't send a sync-step-1, so we send a sync-done
                logger.trace("sending sync-done");
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
              }
              return;
            case "update":
              await this.broadcast(message);
              await this.write(message.payload.update);
              return;
            case "sync-step-2":
              await this.broadcast(message);
              await this.write(message.payload.update);
              if (!client) {
                throw new Error(`Client not found`, {
                  cause: { clientId: message.context.clientId },
                });
              }
              logger.trace("sending sync-done");
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
              return;
            case "sync-done":
            case "auth-message":
              // Sync-done & auth-message messages are informational from client, no action needed
              return;
            default:
              throw new Error("unknown message type");
          }
        default:
          // Broadcast the message to all clients
          await this.broadcast(message);
      }

      logger.trace("message processed successfully");
    } catch (e) {
      logger.withError(e).error("Failed to handle message");
      throw e;
    }
  }

  #destroyed = false;
  /**
   * Destroy the document.
   */
  public async destroy() {
    if (this.#destroyed) {
      return;
    }
    this.#destroyed = true;

    this.emit("destroy", [this]);
    this.logger.trace("destroying document");

    await this.storage.unload(this.id);
    this.clients.forEach((client) => client.unsubscribeFromDocument(this));
    this.clients.clear();
    this.logger.trace("document destroyed");
    super.destroy();
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
