import { emitWideEvent } from "./logger";
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
import type { DocumentStorage } from "teleportal/storage";
import { Observable } from "../lib/utils";
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
    this.#dedupe = args.dedupe ?? new TtlDedupe();
    this.#onCleanupScheduled = args.onCleanupScheduled;
  }

  public get storage(): DocumentStorage {
    return this.#storage;
  }

  /**
   * Load the most recent state for initial sync.
   */
  async load() {
    if (this.#loaded) {
      return;
    }

    this.#loaded = true;

    try {
      this.#unsubscribe = this.#pubSub.subscribe(
        `document/${this.namespacedDocumentId}` as const,
        async (binary, sourceId) => {
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
            emitWideEvent("error", {
              event_type: "replication_decode_failed",
              timestamp: new Date().toISOString(),
              document_id: this.documentId,
              session_id: this.id,
              source_node_id: sourceId,
              error,
            });
            return;
          }

          if (message.document !== this.documentId) {
            return;
          }

          try {
            const shouldAccept = this.#dedupe.shouldAccept(
              this.namespacedDocumentId,
              message.id,
            );

            if (!shouldAccept) {
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
          } catch (err) {
            emitWideEvent("error", {
              event_type: "replication_apply_failed",
              timestamp: new Date().toISOString(),
              document_id: this.documentId,
              session_id: this.id,
              message_id: message.id,
              source_node_id: sourceId,
              error: {
                type: err instanceof Error ? err.name : "Error",
                message: err instanceof Error ? err.message : String(err),
              },
            });
          }
        },
      );
    } catch (error) {
      emitWideEvent("error", {
        event_type: "session_load_failed",
        timestamp: new Date().toISOString(),
        document_id: this.documentId,
        session_id: this.id,
        error,
      });
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
    const clientsToBroadcast = [...this.#clients.entries()].filter(
      ([id]) => id !== excludeClientId,
    );

    for (const [clientId, client] of clientsToBroadcast) {
      try {
        await client.send(message);
      } catch (error) {
        emitWideEvent("error", {
          event_type: "broadcast_send_failed",
          timestamp: new Date().toISOString(),
          document_id: this.documentId,
          session_id: this.id,
          message_id: message.id,
          client_id: clientId,
          error,
        });
      }
    }
  }

  /**
   * Write an update to the storage.
   */
  async write(update: Update, context?: Context) {
    try {
      await this.#storage.handleUpdate(this.namespacedDocumentId, update);

      this.call("document-write", {
        documentId: this.documentId,
        namespacedDocumentId: this.namespacedDocumentId,
        sessionId: this.id,
        encrypted: this.encrypted,
        context,
      });

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
    } catch (error) {
      emitWideEvent("error", {
        event_type: "storage_write_failed",
        timestamp: new Date().toISOString(),
        document_id: this.documentId,
        session_id: this.id,
        error,
      });
      throw error;
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
    if (message.encrypted !== this.encrypted) {
      const error = new Error(
        "Message encryption and document encryption are mismatched",
      );
      emitWideEvent("error", {
        event_type: "encryption_mismatch",
        timestamp: new Date().toISOString(),
        document_id: this.documentId,
        session_id: this.id,
        message_id: message.id,
        message_encrypted: message.encrypted,
        document_encrypted: this.encrypted,
        error,
      });
      throw error;
    }

    try {
      switch (message.type) {
        case "doc": {
          switch (message.payload.type) {
            case "sync-step-1": {
              const doc = await this.#storage.handleSyncStep1(
                this.namespacedDocumentId,
                message.payload.sv,
              );

              if (!client) {
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

              return;
            }
            case "update": {
              await this.write(message.payload.update, message.context);

              await Promise.all([
                this.broadcast(message, client?.id),
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

              return;
            }
            case "sync-step-2": {
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

              return;
            }
            case "sync-done": {
              return;
            }
            case "auth-message": {
              return;
            }
            default: {
              emitWideEvent("error", {
                event_type: "unknown_doc_payload_type",
                timestamp: new Date().toISOString(),
                document_id: this.documentId,
                session_id: this.id,
                message_id: message.id,
                unknown_payload_type: (message.payload as { type?: string })
                  .type,
              });
              return;
            }
          }
        }
        case "rpc": {
          if (!client) {
            return;
          }

          const rpcMessage = message as RpcMessage<Context>;
          const { requestType, originalRequestId } = rpcMessage;

          if (requestType === "request") {
            const method = rpcMessage.rpcMethod;

            if (rpcMessage.payload.type !== "success") {
              return;
            }

            const requestPayload = rpcMessage.payload.payload as {
              [key: string]: unknown;
            };

            const handler = this.#rpcHandlers[method];
            if (!handler) {
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
            } catch (error) {
              emitWideEvent("error", {
                event_type: "rpc_handler_failed",
                timestamp: new Date().toISOString(),
                document_id: this.documentId,
                session_id: this.id,
                message_id: rpcMessage.id,
                method,
                error,
              });

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
                emitWideEvent("error", {
                  event_type: "rpc_stream_handler_failed",
                  timestamp: new Date().toISOString(),
                  document_id: this.documentId,
                  session_id: this.id,
                  message_id: rpcMessage.id,
                  method,
                  error,
                });

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
          }

          return;
        }
        default: {
          await Promise.all([
            this.broadcast(message, client?.id),
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

          return;
        }
      }
    } catch (error) {
      emitWideEvent("error", {
        event_type: "apply_message_failed",
        timestamp: new Date().toISOString(),
        document_id: this.documentId,
        session_id: this.id,
        message_id: message.id,
        message_type: message.type,
        error,
      });
      throw error;
    }
  }

  async [Symbol.asyncDispose]() {
    emitWideEvent("info", {
      event_type: "session_dispose_start",
      timestamp: new Date().toISOString(),
      document_id: this.documentId,
      session_id: this.id,
      active_clients: this.#clients.size,
    });

    this.#cancelCleanup();

    try {
      if (this.#unsubscribe) {
        const unsubscribeFn = await this.#unsubscribe;
        await unsubscribeFn();
      }
    } catch (error) {
      emitWideEvent("error", {
        event_type: "session_pubsub_unsubscribe_failed",
        timestamp: new Date().toISOString(),
        document_id: this.documentId,
        session_id: this.id,
        error,
      });
    }

    await this.call("dispose", {
      documentId: this.documentId,
      namespacedDocumentId: this.namespacedDocumentId,
      sessionId: this.id,
    });

    this.destroy();

    emitWideEvent("info", {
      event_type: "session_disposed",
      timestamp: new Date().toISOString(),
      document_id: this.documentId,
      session_id: this.id,
    });
  }

  #scheduleCleanup() {
    this.#cancelCleanup();

    this.#cleanupTimeoutId = setTimeout(() => {
      this.#cleanupTimeoutId = undefined;
      this.#onCleanupScheduled(this);
    }, this.#CLEANUP_DELAY_MS);
  }

  #cancelCleanup() {
    if (this.#cleanupTimeoutId !== undefined) {
      clearTimeout(this.#cleanupTimeoutId);
      this.#cleanupTimeoutId = undefined;
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
