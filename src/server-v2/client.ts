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
  }

  /**
   * Send a message to the client.
   * Direction: `Server -> Client`
   * @param message - The message to send.
   * @returns A promise that resolves when the message is sent.
   */
  async send(message: Message<Context>): Promise<void> {
    this.#logger.trace(`sending message: ${message.id}`);
    const writer = this.#writable.getWriter();
    try {
      await writer.ready;
      await writer.write(message);
    } finally {
      writer.releaseLock();
    }
  }
}
