import type { ServerContext, Message } from "teleportal";
import type { Logger } from "./logger";

export class Client<Context extends ServerContext> {
  /**
   * The ID of the client.
   */
  public readonly id: string;
  #writable: WritableStream<Message<Context>>;
  #logger: Logger;

  constructor(args: {
    id: string;
    writable: WritableStream<Message<Context>>;
    logger: Logger;
  }) {
    this.id = args.id;
    this.#writable = args.writable;
    this.#logger = args.logger
      .child()
      .withContext({ name: "client", clientId: this.id });

    this.#logger
      .withMetadata({ clientId: this.id })
      .debug("Client instance created");
  }

  /**
   * Send a message to the client.
   * Direction: `Server -> Client`
   * @param message - The message to send.
   * @returns A promise that resolves when the message is sent.
   */
  async send(message: Message<Context>): Promise<void> {
    const msgLogger = this.#logger.child().withContext({
      messageId: message.id,
      documentId: message.document,
    });

    msgLogger
      .withMetadata({
        messageId: message.id,
        documentId: message.document,
        messageType: message.type,
        payloadType: message.payload?.type,
      })
      .trace("Sending message to client");

    const writer = this.#writable.getWriter();
    try {
      await writer.ready;
      await writer.write(message);

      msgLogger
        .withMetadata({
          messageId: message.id,
          documentId: message.document,
        })
        .debug("Message sent successfully");
    } catch (error) {
      msgLogger
        .withError(error as Error)
        .withMetadata({
          messageId: message.id,
          documentId: message.document,
          messageType: message.type,
        })
        .error("Failed to send message to client");
      throw error;
    } finally {
      writer.releaseLock();
    }
  }

  toString() {
    return `Client(id: ${this.id})`;
  }

  toJSON() {
    return {
      id: this.id,
    };
  }
}
