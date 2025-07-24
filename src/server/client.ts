import { Observable, type Message, type ServerContext } from "teleportal";
import { Document } from "./document";
import type { Logger } from "./logger";

/**
 * The Client class represents a client connected to the server.
 *
 * It is responsible for sending and receiving messages to and from the client.
 *
 * It also provides a way to subscribe to and unsubscribe from documents.
 */
export class Client<Context extends ServerContext> extends Observable<{
  destroy: (client: Client<Context>) => void;
  "document-added": (document: Document<Context>) => void;
  "document-removed": (document: Document<Context>) => void;
}> {
  public readonly id: string;
  public readonly documents = new Set<Document<Context>>();
  private readonly writer: WritableStreamDefaultWriter<Message<Context>>;
  private readonly logger: Logger;

  constructor({
    id,
    writable,
    logger,
  }: {
    id: string;
    writable: WritableStream<Message<Context>>;
    logger: Logger;
  }) {
    super();
    this.id = id;
    this.writer = writable.getWriter();
    this.logger = logger.child().withContext({ name: "client", clientId: id });
  }

  public async send(message: Message<Context>) {
    try {
      this.logger
        .withMetadata({
          messageId: message.id,
          payloadType: message.payload.type,
        })
        .trace("sending message");
      await this.writer.ready;
      await this.writer.write(message);
      this.logger
        .withMetadata({
          messageId: message.id,
          payloadType: message.payload.type,
        })
        .trace("message sent to client");
    } catch (e) {
      this.logger
        .withError(e)
        .error("Failed to send message, tearing down client");
      await this.destroy();
    }
  }

  /**
   * Subscribe to a document
   */
  public subscribeToDocument(document: Document<Context>): void {
    if (this.documents.has(document)) {
      return;
    }
    this.documents.add(document);
    document.addClient(this);
    this.logger
      .withMetadata({ documentId: document.id })
      .trace("subscribed to document");
    this.call("document-added", document);
  }

  /**
   * Unsubscribe from a document
   */
  public unsubscribeFromDocument(document: Document<Context>): void {
    if (!this.documents.has(document)) {
      return;
    }
    this.logger
      .withMetadata({ documentId: document.id })
      .trace("unsubscribing from document");
    this.documents.delete(document);
    document.removeClient(this);
    this.logger
      .withMetadata({ documentId: document.id })
      .trace("unsubscribed from document");
    this.call("document-removed", document);
  }

  /**
   * Get the number of documents this client is subscribed to
   */
  public getDocumentCount(): number {
    return this.documents.size;
  }

  #destroyed = false;

  public async destroy() {
    if (this.#destroyed) {
      return;
    }
    this.#destroyed = true;
    this.logger.trace("disposing client");
    for (const document of this.documents) {
      this.unsubscribeFromDocument(document);
    }
    try {
      await this.writer.releaseLock();
    } catch (e) {
      this.logger.withError(e).error("Failed to release lock, aborting client");
      try {
        await this.writer.abort();
      } catch (e) {
        this.logger
          .withError(e)
          .error("Failed to abort client, ignoring error");
      }
    }
    await this.call("destroy", this);
    super.destroy();
  }
}
