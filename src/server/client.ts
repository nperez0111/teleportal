import type { ServerContext, Message } from "teleportal";
import type { Logger } from "./logger";

type QueuedSend<Context extends ServerContext> = {
  message: Message<Context>;
  resolve: () => void;
  reject: (error: Error) => void;
};

export class Client<Context extends ServerContext> {
  /**
   * The ID of the client.
   */
  public readonly id: string;
  #writable: WritableStream<Message<Context>>;
  #logger: Logger;
  #sendQueue: QueuedSend<Context>[] = [];
  #processingQueue = false;

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
    return new Promise((resolve, reject) => {
      this.#sendQueue.push({ message, resolve, reject });
      this.#processQueue();
    });
  }

  /**
   * Process the send queue serially to prevent concurrent writer access.
   */
  async #processQueue(): Promise<void> {
    // If already processing or queue is empty, return
    if (this.#processingQueue || this.#sendQueue.length === 0) {
      return;
    }

    this.#processingQueue = true;

    while (this.#sendQueue.length > 0) {
      const { message, resolve, reject } = this.#sendQueue.shift()!;

      try {
        await this.#sendMessage(message);
        resolve();
      } catch (error) {
        reject(error as Error);
      }
    }

    this.#processingQueue = false;
  }

  /**
   * Internal method to actually send a message.
   * This method handles getting and releasing the writer.
   */
  async #sendMessage(message: Message<Context>): Promise<void> {
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
