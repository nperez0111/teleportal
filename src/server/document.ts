import type { Message, ServerContext, YSink } from "../lib";
import type { LowLevelDocumentStorage } from "../storage";
import { logger, type Logger } from "./logger";
import type { Server } from "./server";

export function getDocumentId(name: string, context: ServerContext) {
  return context.room ? context.room + "/" + name : name;
}

export type DocumentHooks<Context extends ServerContext> = {
  onUnload?: (document: Document<Context>) => Promise<void> | void;
};

export class Document<Context extends ServerContext>
  implements YSink<Context, {}>
{
  public readonly id: string;
  public readonly name: string;
  private readonly clients: Set<string> = new Set();
  private storage: LowLevelDocumentStorage;
  private hooks?: DocumentHooks<Context>;
  public writable: WritableStream<Message<Context>>;
  // TODO should this be public?
  public server: Server<Context>;
  private logger: Logger;

  constructor({
    id,
    name,
    storage,
    hooks,
    server,
  }: {
    id: string;
    name: string;
    storage: LowLevelDocumentStorage;
    server: Server<Context>;
    hooks?: DocumentHooks<Context>;
  }) {
    this.id = id;
    this.name = name;
    this.hooks = hooks;
    this.storage = storage;
    this.server = server;
    this.logger = logger.child({
      name: "document",
      documentName: this.name,
      documentId: this.id,
    });
    this.writable = new WritableStream({
      write: async (message) => {
        if (message.type === "doc") {
          await this.storage.onMessage(message, this);
        }
      },
    });
  }

  public async write(message: Message<Context>) {
    this.logger.trace(
      {
        messageId: message.id,
      },
      "writing message",
    );
    const writer = this.writable.getWriter();
    await writer.write(message);
    writer.releaseLock();
  }

  public subscribe(clientId: string) {
    this.logger.trace(
      {
        clientId,
      },
      "client subscribed to document",
    );
    this.clients.add(clientId);
  }

  public async unsubscribe(clientId: string) {
    this.logger.trace(
      {
        clientId,
      },
      "client unsubscribed from document",
    );
    this.clients.delete(clientId);
    if (this.clients.size === 0) {
      this.logger.trace({}, "document is now empty, unloading");
      await this.hooks?.onUnload?.(this);
      await this.storage.onUnload(this);
      await this.writable.close();
    }
  }

  /**
   * Broadcast a message to all subscribers of the document.
   * @param message - The message to broadcast.
   * @param sourceClientId - The id of the client that originated the message.
   */
  public async broadcast(message: Message<Context>, sourceClientId?: string) {
    const origin = this.server.clients.get(sourceClientId as string) ?? this;

    this.logger.trace(
      {
        sourceClientId,
        documentId: this.id,
        messageId: message.id,
      },
      "broadcasting message",
    );

    await Promise.all(
      this.clients.values().map(async (clientId) => {
        if (clientId === sourceClientId) {
          return;
        }
        this.logger.trace(
          {
            clientId,
            documentId: this.id,
            messageId: message.id,
          },
          "sending message to client",
        );
        await this.server.clients.get(clientId)?.send(message, origin);
      }),
    );
  }
}
