import type { ServerContext, Message } from "teleportal";
import { emitWideEvent } from "./logger";
import { Observable } from "../lib/utils";

type QueuedSend<Context extends ServerContext> = {
  message: Message<Context>;
  resolve: () => void;
  reject: (error: Error) => void;
};

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
  #writable: WritableStream<Message<Context>>;
  #sendQueue: QueuedSend<Context>[] = [];
  #processingQueue = false;

  constructor(args: {
    id: string;
    writable: WritableStream<Message<Context>>;
  }) {
    super();
    this.id = args.id;
    this.#writable = args.writable;
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
    const writer = this.#writable.getWriter();
    try {
      await writer.ready;
      await writer.write(message);
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
