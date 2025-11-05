import { DocMessage, type Message, type ServerContext, type Update } from "teleportal";
import type { DocumentStorage } from "teleportal/storage";
import type { Logger } from "teleportal/server";
import type { Replicator } from "../api/types";
import { TtlDedupe } from "./dedupe";

export class Session<Context extends ServerContext> {
  public readonly documentId: string;
  public readonly name: string;
  public readonly encrypted: boolean;

  #storage: DocumentStorage;
  #replicator: Replicator;
  #logger: Logger;
  #dedupe: TtlDedupe;
  #loaded = false;
  #clients = new Map<string, { send: (m: Message<Context>) => Promise<void> }>();
  #unsubscribe: Promise<() => Promise<void>> | null = null;

  constructor(args: {
    documentId: string;
    name: string;
    encrypted: boolean;
    storage: DocumentStorage;
    replicator: Replicator;
    logger: Logger;
    dedupe?: TtlDedupe;
  }) {
    this.documentId = args.documentId;
    this.name = args.name;
    this.encrypted = args.encrypted;
    this.#storage = args.storage;
    this.#replicator = args.replicator;
    this.#logger = args.logger.child().withContext({ name: "session", documentId: this.documentId, document: this.name });
    this.#dedupe = args.dedupe ?? new TtlDedupe();
  }

  async load() {
    if (this.#loaded) return;
    this.#loaded = true;
    this.#unsubscribe = this.#replicator.subscribe(this.documentId, async (message) => {
      try {
        // drop mismatched documents defensively
        if (message.document !== this.name) return;
        if (!this.#dedupe.shouldAccept(this.documentId, message.id)) return;
        await this.apply(message);
      } catch (e) {
        this.#logger.withError?.(e as any).error?.("Failed to apply replicated message");
      }
    });
  }

  addClient(client: { id: string; send: (m: Message<Context>) => Promise<void> }) {
    this.#clients.set(client.id, { send: client.send });
  }

  removeClient(client: { id: string }) {
    this.#clients.delete(client.id);
  }

  async broadcast(message: Message<Context>, excludeClientId?: string) {
    for (const [id, client] of this.#clients) {
      if (excludeClientId && id === excludeClientId) continue;
      await client.send(message);
    }
  }

  async write(update: Update) {
    await this.#storage.write(this.documentId, update);
  }

  async apply(message: Message<Context>, client?: { id: string; send: (m: Message<Context>) => Promise<void> }) {
    const log = this.#logger.child().withContext({ messageId: message.id, payloadType: (message as any).payload?.type });

    // Validate encryption consistency
    if (message.encrypted !== this.encrypted) {
      throw new Error("Message encryption and document encryption are mismatched");
    }

    switch (message.type) {
      case "doc": {
        switch (message.payload.type) {
          case "sync-step-1": {
            if (!client) return;
            const { update, stateVector } = await this.#storage.handleSyncStep1(this.documentId, message.payload.sv);
            await client.send(
              new DocMessage(this.name, { type: "sync-step-2", update }, message.context, this.encrypted),
            );
            await client.send(
              new DocMessage(this.name, { type: "sync-step-1", sv: stateVector }, message.context, this.encrypted),
            );
            return;
          }
          case "update": {
            await this.broadcast(message, client?.id);
            await this.write(message.payload.update);
            await this.#replicator.publish(this.documentId, message);
            return;
          }
          case "sync-step-2": {
            await this.broadcast(message, client?.id);
            await this.#storage.handleSyncStep2(this.documentId, message.payload.update);
            if (client) {
              await client.send(new DocMessage(this.name, { type: "sync-done" }, message.context, this.encrypted));
            }
            await this.#replicator.publish(this.documentId, message);
            return;
          }
          case "sync-done":
          case "auth-message":
            return;
          default:
            log.trace?.("unknown doc payload type");
            return;
        }
      }
      default: {
        await this.broadcast(message, client?.id);
        await this.#replicator.publish(this.documentId, message);
        return;
      }
    }
  }

  async [Symbol.asyncDispose]() {
    try {
      await (await this.#unsubscribe ?? (async () => async () => {})())();
    } catch {}
  }
}
