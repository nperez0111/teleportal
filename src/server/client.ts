import type { ServerContext, Message } from "teleportal";
import { emitWideEvent } from "./logger";
import { Observable } from "../lib/utils";

export class Client<Context extends ServerContext> extends Observable<{
  "client-message": (ctx: {
    clientId: string;
    message: Message<Context>;
    direction: "out";
  }) => void;
}> {
  /**
   * The ID of the client.
   */
  public readonly id: string;
  #write: (message: Message<Context>) => void | Promise<void>;

  constructor(args: { id: string; write: (message: Message<Context>) => void | Promise<void> }) {
    super();
    this.id = args.id;
    this.#write = args.write;
  }

  /**
   * Send a message to the client.
   * Direction: `Server -> Client`
   * @param message - The message to send.
   * @returns A promise that resolves when the message is sent.
   */
  async send(message: Message<Context>): Promise<void> {
    this.call("client-message", {
      clientId: this.id,
      message,
      direction: "out",
    });
    try {
      await this.#write(message);
    } catch (error) {
      emitWideEvent("error", {
        event_type: "client_send_failed",
        timestamp: new Date().toISOString(),
        client_id: this.id,
        message_id: message.id,
        document_id: message.document,
        message_type: message.type,
        error,
      });
      throw error;
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
