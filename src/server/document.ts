import type { Message, ServerContext } from "teleportal";
import type { Logger } from "./logger";
import type { Client } from "./client";
import type { MessageResponder } from "./responders";

export class Document<Context extends ServerContext> {
  public readonly id: string;
  public readonly name: string;
  public logger: Logger;
  public readonly clients = new Set<Client<Context>>();
  private readonly responder: MessageResponder;

  protected constructor({
    name,
    id,
    logger,
    storage,
  }: {
    name: string;
    id: string;
    logger: Logger;
    storage: MessageResponder;
  }) {
    this.name = name;
    this.id = id;
    this.logger = logger.withContext({ name: "document", documentId: id });
    this.responder = storage;
  }

  /**
   * Write a message to the document's storage
   */
  public async write(message: Message<Context>) {
    if (Document.getDocumentId(message) !== this.id) {
      throw new Error("Received message for wrong document", {
        cause: {
          messageId: message.id,
          documentId: this.id,
        },
      });
    }

    this.logger
      .withMetadata({ messageId: message.id })
      .trace("writing message to document");

    await this.responder.onMessage({
      message,
      document: this,
    });

    this.logger
      .withMetadata({ messageId: message.id })
      .trace("message written to document");
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
   * Get the document ID from a message.
   */
  static getDocumentId(message: Message<ServerContext>) {
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
    storage: MessageResponder;
  }) {
    return new Document({
      id: Document.getDocumentId(ctx.message),
      name: ctx.message.document,
      logger: ctx.logger,
      storage: ctx.storage,
    });
  }

  /**
   * Destroy the document.
   */
  public async destroy() {
    this.logger.trace("destroying document");
    await this.responder.destroy(this);
  }
}
