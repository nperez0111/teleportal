import { getLogger, Logger } from "@logtape/logtape";
import {
  decodeMessage,
  DocMessage,
  type Message,
  type PubSub,
  type ServerContext,
  type SyncStep2Update,
  type Update,
} from "teleportal";
import type { MetricsCollector } from "teleportal/monitoring";
import {
  RpcMessage,
  type RpcError,
  type RpcHandlerRegistry,
  type RpcServerContext,
  type RpcSuccess,
} from "teleportal/protocol";
import type {
  DocumentStorage,
  EncryptedDocumentStorage,
} from "teleportal/storage";
import { Observable } from "../lib/utils";
import { toErrorDetails } from "../logging";
import { Client } from "./client";
import { TtlDedupe } from "./dedupe";
import type { DocumentMessageSource, SessionEvents } from "./events";
import type { Server } from "./server";

export class Session<Context extends ServerContext> extends Observable<
  SessionEvents<Context>
> {
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
  #metrics: MetricsCollector | undefined;
  #documentSizeConfig:
    | { warningThreshold?: number; limit?: number }
    | undefined;
  #sizeWarningEmitted = false;
  #sizeLimitEmitted = false;
  #loaded = false;

  #clients = new Map<string, Client<Context>>();
  #unsubscribe: Promise<() => Promise<void>> | null = null;
  #cleanupTimeoutId: ReturnType<typeof setTimeout> | undefined;
  #onCleanupScheduled: (session: Session<Context>) => void;
  readonly #CLEANUP_DELAY_MS = 60_000;
  #rpcHandlers: RpcHandlerRegistry;
  #server: Server<Context>;

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
    metricsCollector?: MetricsCollector;
    documentSizeConfig?: { warningThreshold?: number; limit?: number };
    rpcHandlers?: RpcHandlerRegistry;
    server: Server<Context>;
  }) {
    super();
    this.documentId = args.documentId;
    this.namespacedDocumentId = args.namespacedDocumentId;
    this.id = args.id;
    this.encrypted = args.encrypted;
    this.#storage = args.storage;
    this.#pubSub = args.pubSub;
    this.#nodeId = args.nodeId;
    this.#metrics = args.metricsCollector;
    this.#documentSizeConfig = args.documentSizeConfig;
    this.#rpcHandlers = args.rpcHandlers ?? {};
    this.#server = args.server;
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
        hasRpcHandlers: args.rpcHandlers !== undefined,
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
            message = decodeMessage(binary, (ctx) => {
              if (ctx.type === "rpc") {
                return this.#rpcHandlers[ctx.method]?.[ctx.requestType]?.decode(
                  ctx.payload,
                );
              }
              return undefined;
            });
          } catch (error) {
            replicationLogger
              .with({ error: toErrorDetails(error as Error) })
              .with({ sourceNodeId: sourceId })
              .error("Failed to decode replicated message");
            return;
          }

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

              this.#emitDocumentMessage(
                message,
                undefined,
                "replication",
                sourceId,
                true,
              );

              return;
            }

            await this.apply(message, undefined, {
              sourceNodeId: sourceId,
              deduped: false,
            });

            replicationLogger
              .with({
                messageId: message.id,
                documentId: message.document,
                sourceNodeId: sourceId,
              })
              .debug("Replicated message applied successfully");
          } catch (err) {
            replicationLogger
              .with({
                error: toErrorDetails(err as Error),
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

    if (!hadClient) {
      this.call("client-join", {
        clientId: client.id,
        documentId: this.documentId,
        namespacedDocumentId: this.namespacedDocumentId,
        sessionId: this.id,
      });
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
    const client = this.#clients.get(id);
    this.#clients.delete(id);

    if (client) {
      this.call("client-leave", {
        clientId: id,
        documentId: this.documentId,
        namespacedDocumentId: this.namespacedDocumentId,
        sessionId: this.id,
      });

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

      client.destroy();
    }
  }

  /**
   * Broadcast a message to all clients in the session.
   */
  async broadcast(message: Message<Context>, excludeClientId?: string) {
    const broadcastLogger = this.#logger.with({
      messageId: message.id,
    });

    const clientsToBroadcast = [...this.#clients.entries()].filter(
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
  async write(update: Update, context?: Context) {
    const writeLogger = this.#logger.with({
      documentId: this.documentId,
      namespacedDocumentId: this.namespacedDocumentId,
    });

    writeLogger.debug("Writing update to storage");

    try {
      await this.#storage.handleUpdate(this.namespacedDocumentId, update);

      this.call("document-write", {
        documentId: this.documentId,
        namespacedDocumentId: this.namespacedDocumentId,
        sessionId: this.id,
        encrypted: this.encrypted,
        context,
      });
      await this.#updateDocumentSizeMetrics(context);

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

  async #updateDocumentSizeMetrics(context?: Context) {
    const meta = await this.#storage.getDocumentMetadata(
      this.namespacedDocumentId,
    );

    const sizeBytes = meta.sizeBytes ?? 0;
    const warningThreshold =
      meta.sizeWarningThreshold ?? this.#documentSizeConfig?.warningThreshold;
    const sizeLimit = meta.sizeLimit ?? this.#documentSizeConfig?.limit;

    this.#metrics?.recordDocumentSize(
      this.namespacedDocumentId,
      sizeBytes,
      this.encrypted,
    );

    if (warningThreshold !== undefined && sizeBytes >= warningThreshold) {
      if (!this.#sizeWarningEmitted) {
        this.call("document-size-warning", {
          documentId: this.documentId,
          namespacedDocumentId: this.namespacedDocumentId,
          sizeBytes,
          warningThreshold,
          context: context ?? ({} as Context),
        });
        this.#metrics?.incrementSizeWarning(this.namespacedDocumentId);
        this.#sizeWarningEmitted = true;
      }
    } else {
      this.#sizeWarningEmitted = false;
    }

    if (sizeLimit !== undefined && sizeBytes > sizeLimit) {
      if (!this.#sizeLimitEmitted) {
        this.call("document-size-limit-exceeded", {
          documentId: this.documentId,
          namespacedDocumentId: this.namespacedDocumentId,
          sizeBytes,
          sizeLimit,
          context: context ?? ({} as Context),
        });
        this.#metrics?.incrementSizeLimitExceeded(this.namespacedDocumentId);
        this.#sizeLimitEmitted = true;
      }
    } else {
      this.#sizeLimitEmitted = false;
    }
  }

  #emitDocumentMessage(
    message: Message<Context>,
    client: { id: string } | undefined,
    source: DocumentMessageSource,
    sourceNodeId?: string,
    deduped?: boolean,
  ) {
    this.call("document-message", {
      clientId: client?.id,
      documentId: this.documentId,
      namespacedDocumentId: this.namespacedDocumentId,
      sessionId: this.id,
      messageId: message.id,
      messageType: message.type,
      payloadType: (message as any).payload?.type,
      encrypted: message.encrypted,
      context: message.context,
      source,
      sourceNodeId,
      deduped,
    });
  }

  /**
   * Apply a message to the session.
   * @param message - The message to apply.
   * @param client - The client that sent the message (undefined for replication).
   * @param replicationMeta - Metadata for replication messages.
   */
  async apply(
    message: Message<Context>,
    client?: { id: string; send: (m: Message<Context>) => Promise<void> },
    replicationMeta?: { sourceNodeId: string; deduped: boolean },
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

              const encryptedStorage =
                this.encrypted &&
                typeof (this.#storage as EncryptedDocumentStorage)
                  .handleEncryptedUpdate === "function"
                  ? (this.#storage as EncryptedDocumentStorage)
                  : null;

              if (encryptedStorage) {
                const storedUpdate =
                  await encryptedStorage.handleEncryptedUpdate(
                    this.namespacedDocumentId,
                    message.payload.update,
                  );
                if (!storedUpdate) {
                  return;
                }
                this.call("document-write", {
                  documentId: this.documentId,
                  namespacedDocumentId: this.namespacedDocumentId,
                  sessionId: this.id,
                  encrypted: this.encrypted,
                  context: message.context,
                });
                const broadcastMessage = new DocMessage(
                  this.documentId,
                  {
                    type: "update",
                    update: storedUpdate,
                  },
                  message.context,
                  this.encrypted,
                );

                await Promise.all([
                  this.broadcast(broadcastMessage),
                  this.#pubSub.publish(
                    `document/${this.namespacedDocumentId}` as const,
                    broadcastMessage.encoded,
                    this.#nodeId,
                  ),
                ]);

                await this.#updateDocumentSizeMetrics(message.context);

                log
                  .with({
                    messageId: broadcastMessage.id,
                    documentId: this.documentId,
                    clientId: client?.id,
                  })
                  .trace("Encrypted update processed and replicated");

                this.#emitDocumentMessage(
                  broadcastMessage,
                  client,
                  replicationMeta?.sourceNodeId ? "replication" : "client",
                  replicationMeta?.sourceNodeId,
                  replicationMeta?.deduped,
                );

                return;
              }

              await this.write(message.payload.update, message.context);

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

              this.#emitDocumentMessage(
                message,
                client,
                replicationMeta?.sourceNodeId ? "replication" : "client",
                replicationMeta?.sourceNodeId,
                replicationMeta?.deduped,
              );

              return;
            }
            case "sync-step-2": {
              log
                .with({
                  messageId: message.id,
                  documentId: this.documentId,
                })
                .trace("Processing sync-step-2");
              const encryptedStorage =
                this.encrypted &&
                typeof (this.#storage as EncryptedDocumentStorage)
                  .handleEncryptedSyncStep2 === "function"
                  ? (this.#storage as EncryptedDocumentStorage)
                  : null;

              if (encryptedStorage) {
                const payloads =
                  await encryptedStorage.handleEncryptedSyncStep2(
                    this.namespacedDocumentId,
                    message.payload.update,
                  );
                if (payloads.length > 0) {
                  this.call("document-write", {
                    documentId: this.documentId,
                    namespacedDocumentId: this.namespacedDocumentId,
                    sessionId: this.id,
                    encrypted: this.encrypted,
                    context: message.context,
                  });
                  await Promise.all(
                    payloads.map(async (payload: Update) => {
                      const broadcastMessage = new DocMessage(
                        this.documentId,
                        {
                          type: "update",
                          update: payload,
                        },
                        message.context,
                        this.encrypted,
                      );
                      await Promise.all([
                        this.broadcast(broadcastMessage),
                        this.#pubSub.publish(
                          `document/${this.namespacedDocumentId}` as const,
                          broadcastMessage.encoded,
                          this.#nodeId,
                        ),
                      ]);

                      this.#emitDocumentMessage(
                        broadcastMessage,
                        client,
                        replicationMeta?.sourceNodeId
                          ? "replication"
                          : "client",
                        replicationMeta?.sourceNodeId,
                        replicationMeta?.deduped,
                      );
                    }),
                  );
                }

                await this.#updateDocumentSizeMetrics(message.context);

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
                  .trace("Encrypted sync-step-2 completed");

                return;
              }

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

              this.#emitDocumentMessage(
                message,
                client,
                replicationMeta?.sourceNodeId ? "replication" : "client",
                replicationMeta?.sourceNodeId,
                replicationMeta?.deduped,
              );

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
        case "rpc": {
          if (!client) {
            log
              .with({ messageId: message.id })
              .warn("RPC message received without client, cannot respond");
            return;
          }

          const rpcMessage = message as RpcMessage<Context>;
          const { requestType, originalRequestId } = rpcMessage;

          if (requestType === "request") {
            const method = rpcMessage.rpcMethod;

            if (rpcMessage.payload.type !== "success") {
              log
                .with({
                  messageId: rpcMessage.id,
                  documentId: this.documentId,
                  method,
                })
                .warn("RPC request with error payload, ignoring");
              return;
            }

            const requestPayload = rpcMessage.payload.payload as {
              [key: string]: unknown;
            };

            log
              .with({
                messageId: rpcMessage.id,
                documentId: this.documentId,
                method,
              })
              .trace("Processing RPC request");

            const handler = this.#rpcHandlers[method];
            if (!handler) {
              log
                .with({
                  messageId: rpcMessage.id,
                  method,
                })
                .warn("No handler found for RPC method");

              const errorMessage = new RpcMessage(
                this.documentId,
                {
                  type: "error",
                  statusCode: 501,
                  details: `Unknown RPC method: ${method}`,
                  payload: { method },
                },
                method,
                "response",
                rpcMessage.id,
                rpcMessage.context,
                rpcMessage.encrypted,
              );
              await client.send(errorMessage);
              return;
            }

            try {
              const enrichedContext: RpcServerContext = {
                ...rpcMessage.context,
                server: this.#server as any,
                documentId: this.namespacedDocumentId,
                session: this as any,
                userId: rpcMessage.context?.userId,
                clientId: rpcMessage.context?.clientId,
              };
              const result = (await handler.handler(
                requestPayload,
                enrichedContext,
              )) as {
                response: {
                  type: string;
                  payload?: unknown;
                  statusCode?: number;
                  details?: string;
                };
                stream?: AsyncIterable<unknown>;
              };

              if ("stream" in result && result.stream) {
                for await (const chunk of result.stream) {
                  const serializer = (ctx: any) => {
                    if (ctx.type === "rpc" && ctx.requestType === "stream") {
                      return handler.stream?.encode?.(chunk);
                    }
                    return undefined;
                  };
                  const streamMessage = new RpcMessage(
                    this.documentId,
                    { type: "success", payload: chunk },
                    method,
                    "stream",
                    rpcMessage.id,
                    rpcMessage.context,
                    rpcMessage.encrypted,
                    undefined,
                    serializer,
                  );
                  await client.send(streamMessage);
                }
              }

              const responsePayload: RpcSuccess | RpcError =
                (result.response as { type?: string }).type === "error"
                  ? {
                      type: "error",
                      statusCode:
                        (result.response as RpcError).statusCode ?? 500,
                      details:
                        (result.response as RpcError).details ??
                        "Unknown error",
                      payload: (result.response as RpcError).payload,
                    }
                  : {
                      type: "success",
                      payload: result.response,
                    };
              const serializer = (ctx: any) => {
                if (ctx.type === "rpc" && ctx.requestType === "response") {
                  // Only serialize if it's a success response (not an error)
                  if (ctx.message.payload.type === "success") {
                    return handler.response?.encode?.(result.response);
                  }
                }
                return undefined;
              };
              const responseMessage = new RpcMessage(
                this.documentId,
                responsePayload,
                method,
                "response",
                rpcMessage.id,
                rpcMessage.context,
                rpcMessage.encrypted,
                undefined,
                serializer,
              );

              await client.send(responseMessage);

              log
                .with({
                  messageId: rpcMessage.id,
                  documentId: this.documentId,
                  method,
                  responseType: result.response.type,
                })
                .trace("RPC request processed");
            } catch (error) {
              log
                .with({
                  error: toErrorDetails(error as Error),
                  messageId: rpcMessage.id,
                  method,
                })
                .error("RPC handler failed");

              const errorMessage = new RpcMessage(
                this.documentId,
                {
                  type: "error",
                  statusCode: 500,
                  details:
                    error instanceof Error ? error.message : "Internal error",
                },
                method,
                "response",
                rpcMessage.id,
                rpcMessage.context,
                rpcMessage.encrypted,
              );
              await client.send(errorMessage);
            }
          } else if (requestType === "stream") {
            const method = rpcMessage.rpcMethod;
            const handler = this.#rpcHandlers[method];

            log
              .with({
                messageId: rpcMessage.id,
                documentId: this.documentId,
                originalRequestId,
                method,
                hasStreamHandler: !!handler?.streamHandler,
              })
              .trace("Processing RPC stream message");

            if (
              handler?.streamHandler &&
              rpcMessage.payload.type === "success"
            ) {
              try {
                const enrichedContext: RpcServerContext = {
                  ...rpcMessage.context,
                  server: this.#server as any,
                  documentId: this.namespacedDocumentId,
                  session: this as any,
                  userId: rpcMessage.context?.userId,
                  clientId: rpcMessage.context?.clientId,
                };

                await handler.streamHandler(
                  rpcMessage.payload.payload,
                  enrichedContext,
                  rpcMessage.id,
                  async (msg) => {
                    if (client) {
                      await client.send(msg);
                    }
                  },
                );
              } catch (error) {
                log
                  .with({
                    error: toErrorDetails(error as Error),
                    messageId: rpcMessage.id,
                    method,
                  })
                  .error("Stream handler failed");

                if (client) {
                  const errorMessage = new RpcMessage(
                    this.documentId,
                    {
                      type: "error",
                      statusCode: 500,
                      details:
                        error instanceof Error
                          ? error.message
                          : "Stream processing error",
                    },
                    method,
                    "response",
                    originalRequestId ?? rpcMessage.id,
                    rpcMessage.context,
                    rpcMessage.encrypted,
                  );
                  await client.send(errorMessage);
                }
              }
            }
          } else if (requestType === "response") {
            log
              .with({
                messageId: rpcMessage.id,
                documentId: this.documentId,
                originalRequestId,
              })
              .trace("Processing RPC response message");
          }

          return;
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

          this.#emitDocumentMessage(
            message,
            client,
            replicationMeta?.sourceNodeId ? "replication" : "client",
            replicationMeta?.sourceNodeId,
            replicationMeta?.deduped,
          );

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

  async [Symbol.asyncDispose]() {
    this.#logger
      .with({
        documentId: this.documentId,
        sessionId: this.id,
        activeClients: this.#clients.size,
      })
      .info("Disposing session");

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

    // Emit dispose event to allow handlers to clean up resources
    await this.call("dispose", {
      documentId: this.documentId,
      namespacedDocumentId: this.namespacedDocumentId,
      sessionId: this.id,
    });

    this.destroy();

    this.#logger
      .with({
        documentId: this.documentId,
        sessionId: this.id,
      })
      .info("Session disposed");
  }

  #scheduleCleanup() {
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
      clients: [...this.#clients.values()].map((client) => client.toJSON()),
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

  public get clients(): IterableIterator<Client<Context>> {
    return this.#clients.values();
  }
}
