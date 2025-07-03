import type { Message, ServerContext } from "teleportal";
import { Document } from "./document";
import type { Logger } from "./logger";

export class Client<Context extends ServerContext> {
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
    this.id = id;
    this.writer = writable.getWriter();
    this.logger = logger.withContext({ name: "client", clientId: id });
  }

  public get ready() {
    return this.writer.ready;
  }

  public async send(message: Message<Context>) {
    this.logger
      .withMetadata({ messageId: message.id })
      .trace("sending message");
    await this.writer.write(message);
    this.logger
      .withMetadata({ messageId: message.id })
      .trace("message sent to client");
  }

  #destroyed = false;

  public async destroy() {
    if (this.#destroyed) {
      return;
    }
    this.#destroyed = true;
    this.logger.trace("disposing client");
    this.documents.clear();
    await this.writer.releaseLock();
  }
}
