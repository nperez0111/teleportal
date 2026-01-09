import {
  decodeMessage,
  DocMessage,
  type DecodedMilestoneListRequest,
  type Message,
  type MilestoneSnapshot,
  type PubSub,
  type ServerContext,
  type SyncStep2Update,
  type Update,
} from "teleportal";
import type { DocumentStorage } from "teleportal/storage";
import { TtlDedupe } from "./dedupe";
import { Client } from "./client";
import { getLogger, Logger } from "@logtape/logtape";
import { toErrorDetails } from "../logging";

/**
 * A session is a collection of clients which are connected to a document.
 */
export class Session<Context extends ServerContext> {
  /**
   * The client-facing document ID (original document name from client).
   */
  public readonly documentId: string;
  /**
   * The namespaced document ID used for storage and pubsub (includes room prefix if applicable).
   */
  public readonly namespacedDocumentId: string;
  /**
   * The ID of the session.
   */
  public readonly id: string;
  /**
   * Whether the document is encrypted.
   */
  public readonly encrypted: boolean;

  #storage: DocumentStorage;
  #pubSub: PubSub;
  #nodeId: string;
  #logger: Logger;
  #dedupe: TtlDedupe;
  #loaded = false;
  #clients = new Map<string, Client<Context>>();
  #unsubscribe: Promise<() => Promise<void>> | null = null;
  #cleanupTimeoutId: ReturnType<typeof setTimeout> | undefined;
  #onCleanupScheduled: (session: Session<Context>) => void;
  readonly #CLEANUP_DELAY_MS = 60_000;

  constructor(args: {
    documentId: string;
    namespacedDocumentId: string;
    id: string;
    encrypted: boolean;
    storage: DocumentStorage;
    pubSub: PubSub;
    nodeId: string;
    dedupe?: TtlDedupe;
    onCleanupScheduled: (session: Session<Context>) => void;
  }) {
    this.documentId = args.documentId;
    this.namespacedDocumentId = args.namespacedDocumentId;
    this.id = args.id;
    this.encrypted = args.encrypted;
    this.#storage = args.storage;
    this.#pubSub = args.pubSub;
    this.#nodeId = args.nodeId;
    this.#logger = getLogger(["teleportal", "server", "session"]).with({
      name: "session",
      documentId: this.documentId,
      namespacedDocumentId: this.namespacedDocumentId,
      sessionId: this.id,
    });
    this.#dedupe = args.dedupe ?? new TtlDedupe();
    this.#onCleanupScheduled = args.onCleanupScheduled;

    this.#logger
      .with({
        documentId: this.documentId,
        namespacedDocumentId: this.namespacedDocumentId,
        sessionId: this.id,
        encrypted: this.encrypted,
        nodeId: this.#nodeId,
        hasCustomDedupe: !!args.dedupe,
      })
      .debug("Session instance created");
  }

  public get storage(): DocumentStorage {
    return this.#storage;
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
      .with({ documentId: this.documentId, sessionId: this.id })
      .info("Loading session");

    this.#loaded = true;

    try {
      this.#unsubscribe = this.#pubSub.subscribe(
        `document/${this.namespacedDocumentId}` as const,
        async (binary, sourceId) => {
          const replicationLogger = this.#logger.with({
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
              .with({ error: toErrorDetails(error as Error) })
              .with({ sourceNodeId: sourceId })
              .error("Failed to decode replicated message");
            return;
          }

          // Best-effort: ensure it matches the documentId (client-facing)
          if (message.document !== this.documentId) {
            replicationLogger
              .with({
                messageDocumentId: message.document,
                sessionDocumentId: this.documentId,
                sourceNodeId: sourceId,
              })
              .warn("Replicated message document ID mismatch, ignoring");
            return;
          }

          replicationLogger
            .with({
              messageId: message.id,
              documentId: message.document,
              messageType: message.type,
              sourceNodeId: sourceId,
            })
            .debug("Received replicated message from other node");

          try {
            const shouldAccept = this.#dedupe.shouldAccept(
              this.namespacedDocumentId,
              message.id,
            );

            if (!shouldAccept) {
              replicationLogger
                .with({
                  messageId: message.id,
                  documentId: message.document,
                  sourceNodeId: sourceId,
                })
                .debug("Replicated message rejected by dedupe");
              return;
            }

            await this.apply(message);

            replicationLogger
              .with({
                messageId: message.id,
                documentId: message.document,
                sourceNodeId: sourceId,
              })
              .debug("Replicated message applied successfully");
          } catch (e) {
            replicationLogger
              .with({
                error: toErrorDetails(e as Error),
                messageId: message.id,
                documentId: message.document,
                sourceNodeId: sourceId,
              })
              .error("Failed to apply replicated message");
          }
        },
      );

      this.#logger
        .with({ documentId: this.documentId, sessionId: this.id })
        .trace("Session loaded and pubSub subscription active");
    } catch (error) {
      this.#logger
        .with({
          error: toErrorDetails(error as Error),
          documentId: this.documentId,
          sessionId: this.id,
        })
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

    // Cancel cleanup if a client reconnects
    if (this.#cleanupTimeoutId !== undefined) {
      this.#cancelCleanup();
    }

    this.#logger
      .with({
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
        .with({
          clientId: id,
          documentId: this.documentId,
          sessionId: this.id,
          totalClients: this.#clients.size,
        })
        .debug("Client removed from session");

      // Schedule cleanup if no clients remain
      if (this.#clients.size === 0) {
        this.#scheduleCleanup();
      }
    }
  }

  /**
   * Broadcast a message to all clients in the session.
   */
  async broadcast(message: Message<Context>, excludeClientId?: string) {
    const broadcastLogger = this.#logger.with({
      messageId: message.id,
    });

    const clientsToBroadcast = Array.from(this.#clients.entries()).filter(
      ([id]) => id !== excludeClientId,
    );

    broadcastLogger
      .with({
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
          .with({
            error: toErrorDetails(error as Error),
            messageId: message.id,
            clientId: id,
            documentId: this.documentId,
          })
          .warn("Failed to send message to client during broadcast");
      }
    }

    broadcastLogger
      .with({
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
    const writeLogger = this.#logger.with({
      documentId: this.documentId,
      namespacedDocumentId: this.namespacedDocumentId,
    });

    writeLogger.debug("Writing update to storage");

    try {
      await this.#storage.handleUpdate(this.namespacedDocumentId, update);

      writeLogger.debug("Update written to storage successfully");
    } catch (error) {
      writeLogger
        .with({
          error: toErrorDetails(error as Error),
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
    const log = this.#logger.with({
      messageId: message.id,
      payloadType: (message as any).payload?.type,
      clientId: client?.id,
    });

    log
      .with({
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
        .with({
          error: toErrorDetails(error),
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
                .with({
                  messageId: message.id,
                  documentId: this.documentId,
                })
                .trace("Processing sync-step-1");

              const doc = await this.#storage.handleSyncStep1(
                this.namespacedDocumentId,
                message.payload.sv,
              );

              log
                .with({
                  messageId: message.id,
                  documentId: this.documentId,
                })
                .debug("Sync-step-1 handled, sending responses");

              if (!client) {
                log
                  .with({ messageId: message.id })
                  .warn("sync-step-1 received without client, cannot respond");
                return;
              }

              await client.send(
                new DocMessage(
                  this.documentId,
                  {
                    type: "sync-step-2",
                    update: doc.content.update as unknown as SyncStep2Update,
                  },
                  message.context,
                  this.encrypted,
                ),
              );
              await client.send(
                new DocMessage(
                  this.documentId,
                  { type: "sync-step-1", sv: doc.content.stateVector },
                  message.context,
                  this.encrypted,
                ),
              );

              log
                .with({
                  messageId: message.id,
                  documentId: this.documentId,
                  clientId: client.id,
                })
                .trace("Sync-step-1 completed, responses sent");

              return;
            }
            case "update": {
              log
                .with({
                  messageId: message.id,
                  documentId: this.documentId,
                })
                .trace("Processing update message");

              // wait for confirmed write
              await this.write(message.payload.update);

              // broadcast and replicate
              await Promise.all([
                this.broadcast(message, client?.id),
                this.#pubSub.publish(
                  `document/${this.namespacedDocumentId}` as const,
                  message.encoded,
                  this.#nodeId,
                ),
              ]);

              log
                .with({
                  messageId: message.id,
                  documentId: this.documentId,
                  clientId: client?.id,
                })
                .trace("Update message processed and replicated");

              return;
            }
            case "sync-step-2": {
              log
                .with({
                  messageId: message.id,
                  documentId: this.documentId,
                })
                .trace("Processing sync-step-2");

              await Promise.all([
                this.broadcast(message, client?.id),
                this.#storage.handleSyncStep2(
                  this.namespacedDocumentId,
                  message.payload.update,
                ),
                this.#pubSub.publish(
                  `document/${this.namespacedDocumentId}` as const,
                  message.encoded,
                  this.#nodeId,
                ),
              ]);

              if (!client) {
                log
                  .with({ messageId: message.id })
                  .warn(
                    "sync-step-2 received without client, cannot send sync-done",
                  );
                return;
              }

              await client.send(
                new DocMessage(
                  this.documentId,
                  { type: "sync-done" },
                  message.context,
                  this.encrypted,
                ),
              );

              log
                .with({
                  messageId: message.id,
                  documentId: this.documentId,
                  clientId: client.id,
                })
                .trace("Sync-step-2 completed");

              return;
            }
            case "sync-done": {
              log
                .with({
                  messageId: message.id,
                  documentId: this.documentId,
                })
                .debug("Received sync-done message");
              return;
            }
            case "auth-message": {
              log
                .with({
                  messageId: message.id,
                  documentId: this.documentId,
                  permission: (message.payload as any).permission,
                })
                .debug("Received auth-message");
              return;
            }
            case "milestone-list-request": {
              const payload = message.payload as DecodedMilestoneListRequest;
              log
                .with({
                  messageId: message.id,
                  documentId: this.documentId,
                  snapshotIds: payload.snapshotIds,
                })
                .trace("Processing milestone-list-request");

              if (!client) {
                log
                  .with({ messageId: message.id })
                  .warn(
                    "milestone-list-request received without client, cannot respond",
                  );
                return;
              }

              if (!this.#storage.milestoneStorage) {
                await client.send(
                  new DocMessage(
                    this.documentId,
                    {
                      type: "milestone-auth-message",
                      permission: "denied",
                      reason: "Milestone storage is not available",
                    },
                    message.context,
                    this.encrypted,
                  ),
                );
                return;
              }

              try {
                const milestones =
                  await this.#storage.milestoneStorage.getMilestones(
                    this.namespacedDocumentId,
                  );
                const snapshotIds = payload.snapshotIds ?? [];
                // Filter out milestones that are already known
                const milestoneMetadata = milestones
                  .filter((m) => !snapshotIds.includes(m.id))
                  .map((m) => m.toJSON());

                await client.send(
                  new DocMessage(
                    this.documentId,
                    {
                      type: "milestone-list-response",
                      milestones: milestoneMetadata,
                    },
                    message.context,
                    this.encrypted,
                  ),
                );

                log
                  .with({
                    messageId: message.id,
                    documentId: this.documentId,
                    milestoneCount: milestoneMetadata.length,
                    filteredCount: milestones.length - milestoneMetadata.length,
                  })
                  .trace("Milestone list sent");
              } catch (error) {
                log
                  .with({
                    error: toErrorDetails(error as Error),
                    messageId: message.id,
                  })
                  .error("Failed to get milestones");
                await client.send(
                  new DocMessage(
                    this.documentId,
                    {
                      type: "milestone-auth-message",
                      permission: "denied",
                      reason: `Failed to get milestones: ${(error as Error).message}`,
                    },
                    message.context,
                    this.encrypted,
                  ),
                );
              }
              return;
            }
            case "milestone-snapshot-request": {
              log
                .with({
                  messageId: message.id,
                  documentId: this.documentId,
                  milestoneId: (message.payload as any).milestoneId,
                })
                .trace("Processing milestone-snapshot-request");

              if (!client) {
                log
                  .with({ messageId: message.id })
                  .warn(
                    "milestone-snapshot-request received without client, cannot respond",
                  );
                return;
              }

              if (!this.#storage.milestoneStorage) {
                await client.send(
                  new DocMessage(
                    this.documentId,
                    {
                      type: "milestone-auth-message",
                      permission: "denied",
                      reason: "Milestone storage is not available",
                    },
                    message.context,
                    this.encrypted,
                  ),
                );
                return;
              }

              try {
                const milestoneId = (message.payload as any).milestoneId;
                const milestone =
                  await this.#storage.milestoneStorage.getMilestone(
                    this.namespacedDocumentId,
                    milestoneId,
                  );

                if (!milestone) {
                  await client.send(
                    new DocMessage(
                      this.documentId,
                      {
                        type: "milestone-auth-message",
                        permission: "denied",
                        reason: `Milestone not found: ${milestoneId}`,
                      },
                      message.context,
                      this.encrypted,
                    ),
                  );
                  return;
                }

                const snapshot = await milestone.fetchSnapshot();

                await client.send(
                  new DocMessage(
                    this.documentId,
                    {
                      type: "milestone-snapshot-response",
                      milestoneId,
                      snapshot,
                    },
                    message.context,
                    this.encrypted,
                  ),
                );

                log
                  .with({
                    messageId: message.id,
                    documentId: this.documentId,
                    milestoneId,
                  })
                  .trace("Milestone snapshot sent");
              } catch (error) {
                log
                  .with({
                    error: toErrorDetails(error as Error),
                    messageId: message.id,
                  })
                  .error("Failed to get milestone snapshot");
                await client.send(
                  new DocMessage(
                    this.documentId,
                    {
                      type: "milestone-auth-message",
                      permission: "denied",
                      reason: `Failed to get milestone snapshot: ${(error as Error).message}`,
                    },
                    message.context,
                    this.encrypted,
                  ),
                );
              }
              return;
            }
            case "milestone-create-request": {
              log
                .with({
                  messageId: message.id,
                  documentId: this.documentId,
                })
                .trace("Processing milestone-create-request");

              if (!client) {
                log
                  .with({ messageId: message.id })
                  .warn(
                    "milestone-create-request received without client, cannot respond",
                  );
                return;
              }

              if (!this.#storage.milestoneStorage) {
                await client.send(
                  new DocMessage(
                    this.documentId,
                    {
                      type: "milestone-auth-message",
                      permission: "denied",
                      reason: "Milestone storage is not available",
                    },
                    message.context,
                    this.encrypted,
                  ),
                );
                return;
              }

              try {
                const requestedName = (message.payload as any).name;
                const clientSnapshot = (message.payload as any).snapshot as
                  | MilestoneSnapshot
                  | undefined;

                // Require snapshot from client - server never generates it
                if (!clientSnapshot) {
                  await client.send(
                    new DocMessage(
                      this.documentId,
                      {
                        type: "milestone-auth-message",
                        permission: "denied",
                        reason: "Snapshot is required from client",
                      },
                      message.context,
                      this.encrypted,
                    ),
                  );
                  return;
                }

                const snapshot = clientSnapshot;

                // Auto-generate name if not provided
                let name = requestedName;
                if (!name) {
                  const existingMilestones =
                    await this.#storage.milestoneStorage.getMilestones(
                      this.namespacedDocumentId,
                    );
                  name = `Milestone ${existingMilestones.length + 1}`;
                }

                const createdAt = Date.now();
                const milestoneId =
                  await this.#storage.milestoneStorage.createMilestone({
                    name,
                    documentId: this.namespacedDocumentId,
                    createdAt,
                    snapshot,
                  });

                const milestone =
                  await this.#storage.milestoneStorage.getMilestone(
                    this.namespacedDocumentId,
                    milestoneId,
                  );

                if (!milestone) {
                  throw new Error("Failed to retrieve created milestone");
                }

                await client.send(
                  new DocMessage(
                    this.documentId,
                    {
                      type: "milestone-create-response",
                      milestone: milestone.toJSON(),
                    },
                    message.context,
                    this.encrypted,
                  ),
                );

                log
                  .with({
                    messageId: message.id,
                    documentId: this.documentId,
                    milestoneId,
                    name,
                  })
                  .trace("Milestone created");
              } catch (error) {
                log
                  .with({
                    error: toErrorDetails(error as Error),
                    messageId: message.id,
                  })
                  .error("Failed to create milestone");
                await client.send(
                  new DocMessage(
                    this.documentId,
                    {
                      type: "milestone-auth-message",
                      permission: "denied",
                      reason: `Failed to create milestone: ${(error as Error).message}`,
                    },
                    message.context,
                    this.encrypted,
                  ),
                );
              }
              return;
            }
            case "milestone-update-name-request": {
              log
                .with({
                  messageId: message.id,
                  documentId: this.documentId,
                  milestoneId: (message.payload as any).milestoneId,
                })
                .trace("Processing milestone-update-name-request");

              if (!client) {
                log
                  .with({ messageId: message.id })
                  .warn(
                    "milestone-update-name-request received without client, cannot respond",
                  );
                return;
              }

              if (!this.#storage.milestoneStorage) {
                await client.send(
                  new DocMessage(
                    this.documentId,
                    {
                      type: "milestone-auth-message",
                      permission: "denied",
                      reason: "Milestone storage is not available",
                    },
                    message.context,
                    this.encrypted,
                  ),
                );
                return;
              }

              try {
                const milestoneId = (message.payload as any).milestoneId;
                const name = (message.payload as any).name;

                await this.#storage.milestoneStorage.updateMilestoneName(
                  this.namespacedDocumentId,
                  milestoneId,
                  name,
                );

                const milestone =
                  await this.#storage.milestoneStorage.getMilestone(
                    this.namespacedDocumentId,
                    milestoneId,
                  );

                if (!milestone) {
                  await client.send(
                    new DocMessage(
                      this.documentId,
                      {
                        type: "milestone-auth-message",
                        permission: "denied",
                        reason: `Milestone not found: ${milestoneId}`,
                      },
                      message.context,
                      this.encrypted,
                    ),
                  );
                  return;
                }

                await client.send(
                  new DocMessage(
                    this.documentId,
                    {
                      type: "milestone-update-name-response",
                      milestone: milestone.toJSON(),
                    },
                    message.context,
                    this.encrypted,
                  ),
                );

                log
                  .with({
                    messageId: message.id,
                    documentId: this.documentId,
                    milestoneId,
                    name,
                  })
                  .trace("Milestone name updated");
              } catch (error) {
                log
                  .with({
                    error: toErrorDetails(error as Error),
                    messageId: message.id,
                  })
                  .error("Failed to update milestone name");
                await client.send(
                  new DocMessage(
                    this.documentId,
                    {
                      type: "milestone-auth-message",
                      permission: "denied",
                      reason: `Failed to update milestone name: ${(error as Error).message}`,
                    },
                    message.context,
                    this.encrypted,
                  ),
                );
              }
              return;
            }
            case "milestone-list-response":
            case "milestone-snapshot-response":
            case "milestone-create-response":
            case "milestone-update-name-response":
            case "milestone-auth-message": {
              // These are response messages, just log them
              log
                .with({
                  messageId: message.id,
                  documentId: this.documentId,
                  payloadType: (message.payload as any).type,
                })
                .debug("Received milestone response message");
              return;
            }
            default: {
              log
                .with({
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
            .with({
              messageId: message.id,
              documentId: this.documentId,
              messageType: message.type,
            })
            .debug("Processing non-doc message, broadcasting and replicating");

          await Promise.all([
            this.broadcast(message, client?.id),
            this.#pubSub.publish(
              `document/${this.namespacedDocumentId}` as const,
              message.encoded,
              this.#nodeId,
            ),
          ]);

          log
            .with({
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
        .with({
          error: toErrorDetails(error),
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
      .with({
        documentId: this.documentId,
        sessionId: this.id,
        activeClients: this.#clients.size,
      })
      .info("Disposing session");

    // Cancel any pending cleanup
    this.#cancelCleanup();

    try {
      if (this.#unsubscribe) {
        const unsubscribeFn = await this.#unsubscribe;
        await unsubscribeFn();
        this.#logger
          .with({ documentId: this.documentId, sessionId: this.id })
          .debug("Pubsub subscription unsubscribed");
      }
    } catch (error) {
      this.#logger
        .with({
          error: toErrorDetails(error as Error),
          documentId: this.documentId,
          sessionId: this.id,
        })
        .error("Error unsubscribing from pubSub");
    }

    this.#logger
      .with({
        documentId: this.documentId,
        sessionId: this.id,
      })
      .info("Session disposed");
  }

  /**
   * Schedule cleanup of this session after the delay period.
   */
  #scheduleCleanup() {
    // Clear any existing timeout first
    this.#cancelCleanup();

    this.#logger
      .with({
        documentId: this.documentId,
        sessionId: this.id,
        delayMs: this.#CLEANUP_DELAY_MS,
      })
      .debug("Scheduling session cleanup");

    this.#cleanupTimeoutId = setTimeout(() => {
      this.#cleanupTimeoutId = undefined;
      this.#onCleanupScheduled(this);
    }, this.#CLEANUP_DELAY_MS);
  }

  /**
   * Cancel any pending cleanup timeout.
   */
  #cancelCleanup() {
    if (this.#cleanupTimeoutId !== undefined) {
      clearTimeout(this.#cleanupTimeoutId);
      this.#cleanupTimeoutId = undefined;
      this.#logger
        .with({
          documentId: this.documentId,
          sessionId: this.id,
        })
        .debug("Cancelled scheduled session cleanup");
    }
  }

  toJSON() {
    return {
      documentId: this.documentId,
      namespacedDocumentId: this.namespacedDocumentId,
      id: this.id,
      encrypted: this.encrypted,
      clients: Array.from(this.#clients.values()).map((client) =>
        client.toJSON(),
      ),
    };
  }

  toString() {
    return `Session(documentId: ${this.documentId}, namespacedDocumentId: ${this.namespacedDocumentId}, id: ${this.id}, encrypted: ${this.encrypted}, clients: ${this.#clients
      .values()
      .map((client) => client.toString())
      .toArray()
      .join(", ")})`;
  }

  public get shouldDispose(): boolean {
    return this.#clients.size === 0;
  }

  /**
   * Get the clients in the session.
   */
  public get clients(): IterableIterator<Client<Context>> {
    return this.#clients.values();
  }
}
