import {
  decodeMessage,
  DocMessage,
  type Message,
  type PubSub,
  type ServerContext,
  type Update,
} from "teleportal";
import type { DocumentStorage } from "teleportal/storage";
import type { Logger } from "teleportal/server";
import { TtlDedupe } from "./dedupe";
import { Client } from "./client";

export class Session<Context extends ServerContext> {
  /**
   * The ID of the document.
   */
  public readonly documentId: string;
  /**
   * The ID of the session.
   */
  public readonly id: string;
  /**
   * Whether the document is encrypted.
   */
  public readonly encrypted: boolean;

  #storage: DocumentStorage;
  #pubsub: PubSub;
  #nodeId: string;
  #logger: Logger;
  #dedupe: TtlDedupe;
  #loaded = false;
  #clients = new Map<
    string,
    { send: (m: Message<Context>) => Promise<void> }
  >();
  #unsubscribe: Promise<() => Promise<void>> | null = null;

  constructor(args: {
    documentId: string;
    id: string;
    encrypted: boolean;
    storage: DocumentStorage;
    pubsub: PubSub;
    nodeId: string;
    logger: Logger;
    dedupe?: TtlDedupe;
  }) {
    this.documentId = args.documentId;
    this.id = args.id;
    this.encrypted = args.encrypted;
    this.#storage = args.storage;
    this.#pubsub = args.pubsub;
    this.#nodeId = args.nodeId;
    this.#logger = args.logger.child().withContext({
      name: "session",
      documentId: this.documentId,
      sessionId: this.id,
    });
    this.#dedupe = args.dedupe ?? new TtlDedupe();
  }

  /**
   * Load the most recent state for initial sync.
   */
  async load() {
    if (this.#loaded) return;
    this.#loaded = true;
    this.#unsubscribe = this.#pubsub.subscribe(
      `document/${this.documentId}` as const,
      async (binary, sourceId) => {
        if (sourceId === this.#nodeId) return;
        const message = decodeMessage(binary);
        // Best-effort: ensure it matches the documentId
        if (message.document !== this.documentId) return;

        try {
          if (!this.#dedupe.shouldAccept(this.documentId, message.id)) return;
          await this.apply(message);
        } catch (e) {
          this.#logger
            .withError?.(e as any)
            .error?.("Failed to apply replicated message");
        }
      },
    );
  }

  /**
   * Add a client to the session.
   */
  addClient(client: Client<Context>) {
    this.#clients.set(client.id, client);
  }

  /**
   * Remove a client from the session.
   */
  removeClient(clientId: string | Client<Context>) {
    this.#clients.delete(typeof clientId === "string" ? clientId : clientId.id);
  }

  /**
   * Broadcast a message to all clients in the session.
   */
  async broadcast(message: Message<Context>, excludeClientId?: string) {
    for (const [id, client] of this.#clients) {
      if (id === excludeClientId) {
        continue;
      }
      await client.send(message);
    }
  }

  /**
   * Write an update to the storage.
   */
  async write(update: Update) {
    this.#logger.trace("writing update to storage");
    await this.#storage.write(this.documentId, update);
    this.#logger.trace("update written to storage");
  }

  /**
   * Apply a message to the session.
   */
  async apply(
    message: Message<Context>,
    client?: { id: string; send: (m: Message<Context>) => Promise<void> },
  ) {
    const log = this.#logger.child().withContext({
      messageId: message.id,
      payloadType: (message as any).payload?.type,
    });

    // Validate encryption consistency
    if (message.encrypted !== this.encrypted) {
      throw new Error(
        "Message encryption and document encryption are mismatched",
      );
    }

    switch (message.type) {
      case "doc": {
        switch (message.payload.type) {
          case "sync-step-1": {
            const { update, stateVector } = await this.#storage.handleSyncStep1(
              this.documentId,
              message.payload.sv,
            );
            if (!client) return;
            await client.send(
              new DocMessage(
                this.documentId,
                { type: "sync-step-2", update },
                message.context,
                this.encrypted,
              ),
            );
            await client.send(
              new DocMessage(
                this.documentId,
                { type: "sync-step-1", sv: stateVector },
                message.context,
                this.encrypted,
              ),
            );
            return;
          }
          case "update": {
            await Promise.all([
              this.write(message.payload.update).then(() =>
                this.broadcast(message, client?.id),
              ),
              this.#pubsub.publish(
                `document/${this.documentId}` as const,
                message.encoded,
                this.#nodeId,
              ),
            ]);
            return;
          }
          case "sync-step-2": {
            await Promise.all([
              this.broadcast(message, client?.id),
              this.#storage.handleSyncStep2(
                this.documentId,
                message.payload.update,
              ),
            ]);
            if (!client) return;
            await Promise.all([
              client.send(
                new DocMessage(
                  this.documentId,
                  { type: "sync-done" },
                  message.context,
                  this.encrypted,
                ),
              ),
              this.#pubsub.publish(
                `document/${this.documentId}` as const,
                message.encoded,
                this.#nodeId,
              ),
            ]);
            return;
          }
          case "sync-done":
          case "auth-message":
            return;
          default:
            log.error(
              `unknown doc payload type: ${(message.payload as any).type}`,
            );
            return;
        }
      }
      default: {
        await Promise.all([
          this.broadcast(message, client?.id),
          this.#pubsub.publish(
            `document/${this.documentId}` as const,
            message.encoded,
            this.#nodeId,
          ),
        ]);
        return;
      }
    }
  }

  /**
   * Async dispose the session.
   */
  async [Symbol.asyncDispose]() {
    if (this.#unsubscribe) {
      await (
        await this.#unsubscribe
      )();
    }
  }
}
