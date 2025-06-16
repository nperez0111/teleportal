import * as Y from "yjs";

import type { Message, ServerContext, Update, YSink } from "../lib";
import { DocMessage } from "../lib";
import {
  getEmptyStateVector,
  getEmptyUpdate,
  type DocumentStorage,
} from "../storage";
import { logger, type Logger } from "./logger";
import type { Server } from "./server";

export function getDocumentId(name: string, context: ServerContext) {
  return context.room ? context.room + "/" + name : name;
}

export type DocumentHooks<Context extends ServerContext> = {
  onUnload?: (document: Document<Context>) => Promise<void> | void;
  onStoreUpdate?: (ctx: {
    document: Document<Context>;
    documentId: string;
    update: Update;
  }) => Promise<void> | void;
};

export class Document<Context extends ServerContext>
  implements YSink<Context, {}>
{
  public readonly id: string;
  public readonly name: string;
  private readonly clients: Set<string> = new Set();
  private hooks: DocumentHooks<Context>;
  public writable: WritableStream<Message<Context>>;
  private server: Server<Context>;
  private storage: DocumentStorage;
  private logger: Logger;

  constructor({
    id,
    name,
    hooks,
    server,
    storage,
  }: {
    id: string;
    name: string;
    hooks: DocumentHooks<Context>;
    server: Server<Context>;
    storage: DocumentStorage;
  }) {
    this.id = id;
    this.name = name;
    this.hooks = hooks;
    this.server = server;
    this.storage = storage;
    this.logger = logger.child({ name: "document", documentName: this.name });
    this.writable = new WritableStream({
      write: async (message) => {
        if (message.type === "doc" && message.payload.type === "sync-step-1") {
          this.logger.trace(
            {
              messageId: message.id,
              documentId: getDocumentId(this.name, message.context),
            },
            "got a sync-step-1 from client",
          );

          const client = this.server.clients.get(message.context.clientId);
          if (!client) {
            throw new Error(`Client not found`, {
              cause: {
                clientId: message.context.clientId,
              },
            });
          }
          try {
            const { update, stateVector } = (await this.storage.fetch(
              getDocumentId(this.name, message.context),
            )) ?? {
              // TODO we can make a hook for a fallback file to load the update from?
              update: getEmptyUpdate(),
              stateVector: getEmptyStateVector(),
            };
            this.logger.trace(
              {
                messageId: message.id,
                documentId: getDocumentId(this.name, message.context),
              },
              "sending sync-step-2",
            );
            await client.send(
              new DocMessage(this.name, {
                type: "sync-step-2",
                update: Y.diffUpdateV2(update, message.payload.sv) as Update,
              }),
              this,
            );
            this.logger.trace(
              {
                messageId: message.id,
                documentId: getDocumentId(this.name, message.context),
              },
              "sending sync-step-1",
            );
            await client.send(
              new DocMessage(this.name, {
                type: "sync-step-1",
                sv: stateVector,
              }),
              this,
            );
          } catch (err) {
            this.logger.error(
              {
                err,
                clientId: message.context.clientId,
                messageId: message.id,
                documentId: getDocumentId(this.name, message.context),
              },
              "failed to send sync-step-2",
            );
          }
          // No need to broadcast sync-step-1 messages, they are just for coordinating with the server
          return;
        }
        await this.broadcast(message, message.context.clientId);

        // TODO should this be blocking? Could we be smarter about compaction in memory? Take a look at store-updates.ts
        if (
          message.type === "doc" &&
          (message.payload.type === "sync-step-2" ||
            message.payload.type === "update")
        ) {
          await this.hooks.onStoreUpdate?.({
            document: this,
            documentId: getDocumentId(this.name, message.context),
            update: message.payload.update,
          });

          this.logger.trace(
            {
              messageId: message.id,
              documentId: getDocumentId(this.name, message.context),
            },
            "writing to store",
          );
          await this.storage.write(
            getDocumentId(this.name, message.context),
            message.payload.update,
          );
        }
      },
    });
  }

  public async write(message: Message<Context>) {
    this.logger.trace(
      {
        messageId: message.id,
        documentId: getDocumentId(this.name, message.context),
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
        documentName: this.name,
      },
      "client subscribed to document",
    );
    this.clients.add(clientId);
  }

  public async unsubscribe(clientId: string) {
    this.logger.trace(
      {
        clientId,
        documentName: this.name,
      },
      "client unsubscribed from document",
    );
    this.clients.delete(clientId);
    if (this.clients.size === 0) {
      this.logger.trace(
        {
          documentName: this.name,
        },
        "document is now empty, unloading",
      );
      await this.hooks.onUnload?.(this);
      await this.storage.unload(this.id);
      await this.writable.close();
    }
  }

  /**
   * Broadcast a message to all subscribers of the document.
   * @param message - The message to broadcast.
   * @param sourceClientId - The id of the client that originated the message.
   */
  private async broadcast(message: Message<Context>, sourceClientId?: string) {
    const origin = this.server.clients.get(sourceClientId as string) ?? this;

    this.logger.trace(
      {
        sourceClientId,
        documentId: getDocumentId(this.name, message.context),
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
            documentId: getDocumentId(this.name, message.context),
            messageId: message.id,
          },
          "sending message to client",
        );
        await this.server.clients.get(clientId)?.send(message, origin);
      }),
    );
  }
}
