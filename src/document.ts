import * as Y from "yjs";
import type { ServerContext, YSink } from "./base";
import {
  decodeDocStep,
  DocMessage,
  encodeDocStep,
  type ReceivedMessage,
  type Update,
} from "./protocol";
import type { Server } from "./server";
import { DocumentStorage } from "./storage";

export function getDocumentKey(name: string, context: ServerContext) {
  return context.room ? context.room + "/" + name : name;
}

export type DocumentHooks<Context extends ServerContext> = {
  onUnload?: (document: Document<Context>) => Promise<void> | void;
};

export class Document<Context extends ServerContext>
  implements YSink<Context, {}>
{
  public readonly name: string;
  public readonly clients: Set<string> = new Set();
  private hooks: DocumentHooks<Context>;
  public writable: WritableStream<ReceivedMessage<Context>>;
  private server: Server<Context>;
  private storage: DocumentStorage;

  constructor({
    name,
    hooks,
    server,
    storage,
  }: {
    name: string;
    hooks: DocumentHooks<Context>;
    server: Server<Context>;
    storage: DocumentStorage;
  }) {
    this.name = name;
    this.hooks = hooks;
    this.server = server;
    this.storage = storage;
    this.writable = new WritableStream({
      write: async (message) => {
        if (message.type === "doc") {
          if (message.decoded.type === "sync-step-1") {
            // decoded.payload is the state vector
            const client = this.server.clients.get(message.context.clientId);
            if (!client) {
              throw new Error(`Client not found`, {
                cause: {
                  clientId: message.context.clientId,
                },
              });
            }
            const { update, stateVector } = await this.storage.fetch(
              getDocumentKey(this.name, message.context),
            );

            await client.send(
              new DocMessage(
                this.name,
                encodeDocStep(
                  "sync-step-2",
                  Y.diffUpdateV2(update, message.decoded.payload) as Update,
                ),
                message.context,
              ),
              this,
            );
            await client.send(
              new DocMessage(
                this.name,
                encodeDocStep("sync-step-1", stateVector),
                message.context,
              ),
              this,
            );
            // No need to broadcast sync-step-1 messages, they are just for coordinating with the server
            return;
          }
        }
        await this.broadcast(message, message.context.clientId);

        if (message.type === "doc") {
          // TODO should this be blocking? Could we be smarter about compaction in memory? Take a look at store-updates.ts
          if (
            message.decoded.type === "sync-step-2" ||
            message.decoded.type === "update"
          ) {
            await this.storage.write(
              getDocumentKey(this.name, message.context),
              message.decoded.payload,
            );
          }
        }
      },
    });
  }

  public async checkUnload() {
    if (this.clients.size === 0) {
      await this.hooks.onUnload?.(this);
      await this.writable.close();
    }
  }

  /**
   * Broadcast a message to all subscribers of the document.
   * @param message - The message to broadcast.
   * @param excludeClientId - The id of the client to exclude from the broadcast.
   */
  private async broadcast(
    message: ReceivedMessage<Context>,
    excludeClientId?: string,
  ) {
    const origin = this.server.clients.get(excludeClientId as string) ?? this;

    await Promise.all(
      this.clients.values().map(async (clientId) => {
        if (clientId === excludeClientId) {
          return;
        }
        await this.server.clients.get(clientId)?.send(message, origin);
      }),
    );
  }
}
