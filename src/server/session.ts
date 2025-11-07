import {
  decodeMessage,
  DocMessage,
  type Message,
  type PubSub,
  type ServerContext,
  type Update,
} from "teleportal";
import type { DocumentStorage } from "teleportal/storage";
import type { Logger } from "./logger";
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

    this.#logger
      .withMetadata({
        documentId: this.documentId,
        sessionId: this.id,
        encrypted: this.encrypted,
        nodeId: this.#nodeId,
        hasCustomDedupe: !!args.dedupe,
      })
      .debug("Session instance created");
  }

  /**
   * Load the most recent state for initial sync.
   */
  async load() {
    if (this.#loaded) {
      this.#logger.debug("Session already loaded, skipping");
      return;
    }

    this.#logger
      .withMetadata({ documentId: this.documentId, sessionId: this.id })
      .info("Loading session");

    this.#loaded = true;

    try {
      this.#unsubscribe = this.#pubsub.subscribe(
        `document/${this.documentId}` as const,
        async (binary, sourceId) => {
          const replicationLogger = this.#logger.child().withContext({
            sourceNodeId: sourceId,
          });

          if (sourceId === this.#nodeId) {
            return;
          }

          let message: Message<Context>;
          try {
            message = decodeMessage(binary);
          } catch (error) {
            replicationLogger
              .withError(error as Error)
              .withMetadata({ sourceNodeId: sourceId })
              .error("Failed to decode replicated message");
            return;
          }

          // Best-effort: ensure it matches the documentId
          if (message.document !== this.documentId) {
            replicationLogger
              .withMetadata({
                messageDocumentId: message.document,
                sessionDocumentId: this.documentId,
                sourceNodeId: sourceId,
              })
              .warn("Replicated message document ID mismatch, ignoring");
            return;
          }

          replicationLogger
            .withMetadata({
              messageId: message.id,
              documentId: message.document,
              messageType: message.type,
              sourceNodeId: sourceId,
            })
            .debug("Received replicated message from other node");

          try {
            const shouldAccept = this.#dedupe.shouldAccept(
              this.documentId,
              message.id,
            );

            if (!shouldAccept) {
              replicationLogger
                .withMetadata({
                  messageId: message.id,
                  documentId: message.document,
                  sourceNodeId: sourceId,
                })
                .debug("Replicated message rejected by dedupe");
              return;
            }

            await this.apply(message);

            replicationLogger
              .withMetadata({
                messageId: message.id,
                documentId: message.document,
                sourceNodeId: sourceId,
              })
              .debug("Replicated message applied successfully");
          } catch (e) {
            replicationLogger
              .withError(e as Error)
              .withMetadata({
                messageId: message.id,
                documentId: message.document,
                sourceNodeId: sourceId,
              })
              .error("Failed to apply replicated message");
          }
        },
      );

      this.#logger
        .withMetadata({ documentId: this.documentId, sessionId: this.id })
        .info("Session loaded and pubsub subscription active");
    } catch (error) {
      this.#logger
        .withError(error as Error)
        .withMetadata({ documentId: this.documentId, sessionId: this.id })
        .error("Failed to load session");
      throw error;
    }
  }

  /**
   * Add a client to the session.
   */
  addClient(client: Client<Context>) {
    const hadClient = this.#clients.has(client.id);
    this.#clients.set(client.id, client);

    this.#logger
      .withMetadata({
        clientId: client.id,
        documentId: this.documentId,
        sessionId: this.id,
        totalClients: this.#clients.size,
        wasNewClient: !hadClient,
      })
      .debug(
        hadClient ? "Client re-added to session" : "Client added to session",
      );
  }

  /**
   * Remove a client from the session.
   */
  removeClient(clientId: string | Client<Context>) {
    const id = typeof clientId === "string" ? clientId : clientId.id;
    const hadClient = this.#clients.has(id);
    this.#clients.delete(id);

    if (hadClient) {
      this.#logger
        .withMetadata({
          clientId: id,
          documentId: this.documentId,
          sessionId: this.id,
          totalClients: this.#clients.size,
        })
        .debug("Client removed from session");
    }
  }

  /**
   * Broadcast a message to all clients in the session.
   */
  async broadcast(message: Message<Context>, excludeClientId?: string) {
    const broadcastLogger = this.#logger.child().withContext({
      messageId: message.id,
    });

    const clientsToBroadcast = Array.from(this.#clients.entries()).filter(
      ([id]) => id !== excludeClientId,
    );

    broadcastLogger
      .withMetadata({
        messageId: message.id,
        documentId: this.documentId,
        totalClients: this.#clients.size,
        clientsToBroadcast: clientsToBroadcast.length,
        excludeClientId,
      })
      .debug("Broadcasting message to clients");

    let successCount = 0;
    let errorCount = 0;

    for (const [id, client] of clientsToBroadcast) {
      try {
        await client.send(message);
        successCount++;
      } catch (error) {
        errorCount++;
        broadcastLogger
          .withError(error as Error)
          .withMetadata({
            messageId: message.id,
            clientId: id,
            documentId: this.documentId,
          })
          .warn("Failed to send message to client during broadcast");
      }
    }

    broadcastLogger
      .withMetadata({
        messageId: message.id,
        documentId: this.documentId,
        successCount,
        errorCount,
        totalClients: clientsToBroadcast.length,
      })
      .debug("Broadcast completed");
  }

  /**
   * Write an update to the storage.
   */
  async write(update: Update) {
    const writeLogger = this.#logger.child();

    writeLogger
      .withMetadata({
        documentId: this.documentId,
      })
      .debug("Writing update to storage");

    try {
      await this.#storage.write(this.documentId, update);

      writeLogger
        .withMetadata({
          documentId: this.documentId,
        })
        .debug("Update written to storage successfully");
    } catch (error) {
      writeLogger
        .withError(error as Error)
        .withMetadata({
          documentId: this.documentId,
        })
        .error("Failed to write update to storage");
      throw error;
    }
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
      clientId: client?.id,
    });

    log
      .withMetadata({
        messageId: message.id,
        documentId: this.documentId,
        messageType: message.type,
        payloadType: (message as any).payload?.type,
        encrypted: message.encrypted,
        hasClient: !!client,
        clientId: client?.id,
      })
      .debug("Applying message to session");

    // Validate encryption consistency
    if (message.encrypted !== this.encrypted) {
      const error = new Error(
        "Message encryption and document encryption are mismatched",
      );
      log
        .withError(error)
        .withMetadata({
          messageId: message.id,
          messageEncrypted: message.encrypted,
          documentEncrypted: this.encrypted,
        })
        .error("Encryption mismatch detected");
      throw error;
    }

    try {
      switch (message.type) {
        case "doc": {
          switch (message.payload.type) {
            case "sync-step-1": {
              log
                .withMetadata({
                  messageId: message.id,
                  documentId: this.documentId,
                })
                .info("Processing sync-step-1");

              const { update, stateVector } =
                await this.#storage.handleSyncStep1(
                  this.documentId,
                  message.payload.sv,
                );

              log
                .withMetadata({
                  messageId: message.id,
                  documentId: this.documentId,
                })
                .debug("Sync-step-1 handled, sending responses");

              if (!client) {
                log
                  .withMetadata({ messageId: message.id })
                  .warn("sync-step-1 received without client, cannot respond");
                return;
              }

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

              log
                .withMetadata({
                  messageId: message.id,
                  documentId: this.documentId,
                  clientId: client.id,
                })
                .info("Sync-step-1 completed, responses sent");

              return;
            }
            case "update": {
              log
                .withMetadata({
                  messageId: message.id,
                  documentId: this.documentId,
                })
                .info("Processing update message");

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

              log
                .withMetadata({
                  messageId: message.id,
                  documentId: this.documentId,
                  clientId: client?.id,
                })
                .info("Update message processed and replicated");

              return;
            }
            case "sync-step-2": {
              log
                .withMetadata({
                  messageId: message.id,
                  documentId: this.documentId,
                })
                .info("Processing sync-step-2");

              await Promise.all([
                this.broadcast(message, client?.id),
                this.#storage.handleSyncStep2(
                  this.documentId,
                  message.payload.update,
                ),
              ]);

              if (!client) {
                log
                  .withMetadata({ messageId: message.id })
                  .warn(
                    "sync-step-2 received without client, cannot send sync-done",
                  );
                return;
              }

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

              log
                .withMetadata({
                  messageId: message.id,
                  documentId: this.documentId,
                  clientId: client.id,
                })
                .info("Sync-step-2 completed");

              return;
            }
            case "sync-done": {
              log
                .withMetadata({
                  messageId: message.id,
                  documentId: this.documentId,
                })
                .debug("Received sync-done message");
              return;
            }
            case "auth-message": {
              log
                .withMetadata({
                  messageId: message.id,
                  documentId: this.documentId,
                  permission: (message.payload as any).permission,
                })
                .debug("Received auth-message");
              return;
            }
            default: {
              log
                .withMetadata({
                  messageId: message.id,
                  documentId: this.documentId,
                  unknownPayloadType: (message.payload as any).type,
                })
                .error("Unknown doc payload type");
              return;
            }
          }
        }
        default: {
          log
            .withMetadata({
              messageId: message.id,
              documentId: this.documentId,
              messageType: message.type,
            })
            .debug("Processing non-doc message, broadcasting and replicating");

          await Promise.all([
            this.broadcast(message, client?.id),
            this.#pubsub.publish(
              `document/${this.documentId}` as const,
              message.encoded,
              this.#nodeId,
            ),
          ]);

          log
            .withMetadata({
              messageId: message.id,
              documentId: this.documentId,
              messageType: message.type,
            })
            .debug("Non-doc message processed");

          return;
        }
      }
    } catch (error) {
      log
        .withError(error as Error)
        .withMetadata({
          messageId: message.id,
          documentId: this.documentId,
          messageType: message.type,
          payloadType: (message as any).payload?.type,
        })
        .error("Failed to apply message");
      throw error;
    }
  }

  /**
   * Async dispose the session.
   */
  async [Symbol.asyncDispose]() {
    this.#logger
      .withMetadata({
        documentId: this.documentId,
        sessionId: this.id,
        activeClients: this.#clients.size,
      })
      .info("Disposing session");

    try {
      if (this.#unsubscribe) {
        const unsubscribeFn = await this.#unsubscribe;
        await unsubscribeFn();
        this.#logger
          .withMetadata({ documentId: this.documentId, sessionId: this.id })
          .debug("Pubsub subscription unsubscribed");
      }
    } catch (error) {
      this.#logger
        .withError(error as Error)
        .withMetadata({ documentId: this.documentId, sessionId: this.id })
        .error("Error unsubscribing from pubsub");
    }

    this.#logger
      .withMetadata({
        documentId: this.documentId,
        sessionId: this.id,
      })
      .info("Session disposed");
  }
}
