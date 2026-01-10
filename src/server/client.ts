import { Observable, type Message, type ServerContext } from "teleportal";
import { toErrorDetails } from "../logging";
import { getLogger } from "@logtape/logtape";
import type { TeleportalServerEvents } from "./events";

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
  #sendQueue: QueuedSend<Context>[] = [];
  #processingQueue = false;
  #events?: Observable<TeleportalServerEvents<Context>>;
  #nodeId: string;

  constructor(args: {
    id: string;
    writable: WritableStream<Message<Context>>;
    events?: Observable<TeleportalServerEvents<Context>>;
    nodeId?: string;
  }) {
    this.id = args.id;
    this.#writable = args.writable;
    this.#events = args.events;
    this.#nodeId = args.nodeId ?? "unknown";

    const logger = getLogger(["teleportal", "server", "client"]).with({
      name: "client",
      clientId: this.id,
    });
    logger.debug("Client instance created", { clientId: this.id });
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
    const logger = getLogger(["teleportal", "server", "client"]).with({
      name: "client",
      clientId: this.id,
    });
    const msgLogger = logger.with({
      messageId: message.id,
      documentId: message.document,
    });

    msgLogger.trace("Sending message to client", {
      messageId: message.id,
      documentId: message.document,
      messageType: message.type,
      payloadType: message.payload?.type,
    });

    const writer = this.#writable.getWriter();
    try {
      await writer.ready;
      await writer.write(message);

      // Best-effort event emission for outbound messages.
      // This is intentionally non-blocking and must not break core server behavior.
      this.#events
        ?.call("client-message", {
          ts: new Date().toISOString(),
          nodeId: this.#nodeId,
          clientId: this.id,
          direction: "out",
          message,
          messageType: message.type,
          payloadType: (message as any).payload?.type,
          documentId: message.document ?? undefined,
          encrypted: (message as any).encrypted,
        })
        .catch(() => {});

      msgLogger.debug("Message sent successfully", {
        messageId: message.id,
        documentId: message.document,
      });
    } catch (error) {
      // Best-effort event emission for outbound failures.
      this.#events
        ?.call("client-message", {
          ts: new Date().toISOString(),
          nodeId: this.#nodeId,
          clientId: this.id,
          direction: "out",
          message,
          messageType: message.type,
          payloadType: (message as any).payload?.type,
          documentId: message.document ?? undefined,
          encrypted: (message as any).encrypted,
          error: {
            name: (error as any)?.name ?? "Error",
            message: (error as any)?.message ?? String(error),
          },
        })
        .catch(() => {});

      msgLogger.error("Failed to send message to client", {
        messageId: message.id,
        documentId: message.document,
        messageType: message.type,
        error: toErrorDetails(error),
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
