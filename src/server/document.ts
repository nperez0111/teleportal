import type { Message, ServerContext, Update } from "teleportal";
import type { Logger } from "./logger";
import type { Client } from "./client";
import type { DocumentStorage } from "teleportal/storage";
import { ObservableV2 } from "lib0/observable";

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
   * Broadcast a message to all clients of the current document.
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
  }

  /**
   * Check if a client is subscribed to this document
   */
  public hasClient(clientId: string): boolean {
    return this.clients.values().some((client) => client.id === clientId);
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
