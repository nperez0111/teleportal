import { uuidv4 } from "lib0/random";
import {
  AckMessage,
  DocMessage,
  InMemoryPubSub,
  type Message,
  type PubSub,
  RpcMessage,
  type ServerContext,
  Transport,
} from "teleportal";
import type { DocumentStorage, MilestoneTrigger } from "teleportal/storage";
import type { RateLimitStorage } from "teleportal/storage";
import { withMessageValidator } from "teleportal/transports";
import {
  type RateLimitRule,
  withRateLimit,
} from "teleportal/transports/rate-limiter";
import { toErrorDetails } from "../logging";
import { getLogger } from "@logtape/logtape";
import { register } from "../monitoring/metrics";
import { Session } from "./session";
import { Client } from "./client";
import {
  HealthStatus,
  StatusData,
  MetricsCollector,
} from "teleportal/monitoring";
import { Observable } from "../lib/utils";
import type { ServerEvents, ClientDisconnectReason } from "./events";
import type { RpcHandlerRegistry } from "teleportal/protocol";

export type ServerOptions<Context extends ServerContext> = {
  /**
   * Retrieve per-document storage.
   */
  storage:
    | DocumentStorage
    | Promise<DocumentStorage>
    | ((ctx: {
        documentId: string;
        context: NoInfer<Context>;
        encrypted: boolean;
      }) => DocumentStorage | Promise<DocumentStorage>);

  /**
   * Optional permission checker for read/write.
   * Either documentId or fileId will be provided, but not both.
   */
  checkPermission?: (ctx: {
    context: NoInfer<Context>;
    documentId?: string;
    fileId?: string;
    message: Message<NoInfer<Context>>;
    type: "read" | "write";
  }) => Promise<boolean>;

  /**
   * PubSub backend for cross-node fanout. Defaults to in-memory.
   */
  pubSub?: PubSub;

  /**
   * Node ID for this server instance. Used to filter out messages from the same node.
   * Defaults to a random UUID.
   */
  nodeId?: string;

  /**
   * Configuration for document size limits and warnings.
   */
  documentSizeConfig?: {
    warningThreshold?: number;
    limit?: number;
  };

  /**
   * Configuration for automatic milestone triggers.
   */
  milestoneTriggerConfig?: {
    defaultTriggers?: MilestoneTrigger[];
  };

  /**
   * RPC handlers for the server.
   * These handlers will be called when RPC messages are received.
   * Built-in handlers (milestone, file) should be merged with any custom handlers.
   */
  rpcHandlers?: RpcHandlerRegistry;

  /**
   * Configuration for rate limiting on client transports.
   * If provided, all transports will be rate-limited before processing messages.
   */
  rateLimitConfig?: {
    /**
     * Array of rate limit rules to enforce.
     * All rules must pass for a message to be allowed.
     */
    rules: RateLimitRule<Context>[];

    /**
     * Maximum message size in bytes
     * @default 10MB
     */
    maxMessageSize?: number;

    /**
     * Default storage backend for rate limit state.
     * Individual rules can override this with their own rateLimitStorage.
     * If not provided, rate limits will be in-memory per transport instance.
     */
    rateLimitStorage?: RateLimitStorage;

    /**
     * Default function to extract user ID from message.
     * Individual rules can override this with their own getUserId.
     */
    getUserId?: (message: Message<NoInfer<Context>>) => string | undefined;

    /**
     * Default function to extract document ID from message.
     * Individual rules can override this with their own getDocumentId.
     */
    getDocumentId?: (message: Message<NoInfer<Context>>) => string | undefined;

    /**
     * Function to check if rate limiting should be skipped for this message.
     * If returns true, all rate limit rules are skipped (message allowed) and no tokens are consumed.
     * Useful for admin users or allow-listed sources.
     */
    shouldSkipRateLimit?: (
      message: Message<NoInfer<Context>>,
    ) => Promise<boolean> | boolean;

    /**
     * Called when rate limit is exceeded
     */
    onRateLimitExceeded?: (details: {
      ruleId: string;
      userId?: string;
      documentId?: string;
      trackBy: string;
      currentCount: number;
      maxMessages: number;
      windowMs: number;
      resetAt: number;
      message: Message<NoInfer<Context>>;
    }) => void;

    /**
     * Called when message size limit is exceeded
     */
    onMessageSizeExceeded?: (details: {
      size: number;
      maxSize: number;
      message: Message<NoInfer<Context>>;
    }) => void;
  };
};

export class Server<Context extends ServerContext> extends Observable<
  ServerEvents<Context>
> {
  /**
   * The options for the server.
   */
  #options: ServerOptions<Context>;
  /**
   * The pubSub for the server.
   */
  readonly pubSub: PubSub;
  /**
   * The node ID for the server.
   */
  #nodeId: string;
  /**
   * The active sessions for the server.
   */
  #sessions = new Map<string, Session<Context>>();
  /**
   * Pending session creation promises to prevent race conditions.
   * Maps composite document ID to the promise that will resolve to the session.
   */
  #pendingSessions = new Map<string, Promise<Session<Context>>>();
  /**
   * Server start time for uptime calculation.
   */
  #startTime = Date.now();
  /**
   * Metrics collector for all monitoring data.
   */
  #metrics!: MetricsCollector;
  /**
   * Cleanup functions returned by handler init() methods.
   */
  #handlerCleanups: (() => void)[] = [];

  constructor(options: ServerOptions<Context>) {
    super();
    this.#options = options;
    const logger = getLogger(["teleportal", "server"]);

    this.pubSub = options.pubSub ?? new InMemoryPubSub();
    this.#nodeId = options.nodeId ?? `node-${uuidv4()}`;
    this.#metrics = new MetricsCollector(register);

    // Initialize RPC handlers
    if (options.rpcHandlers) {
      for (const handler of Object.values(options.rpcHandlers)) {
        if (handler.init) {
          const cleanup = handler.init(this);
          if (cleanup) {
            this.#handlerCleanups.push(cleanup);
          }
        }
      }
    }

    logger.info("Server initialized", {
      nodeId: this.#nodeId,
      hasCustomPubSub: !!options.pubSub,
      hasPermissionChecker: !!options.checkPermission,
    });
  }

  /**
   * Create a composite document ID from room and document name.
   * If room is provided, returns `${room}/${document}`, otherwise returns `document`.
   */
  #getCompositeDocumentId(document: string, context?: Context): string {
    if (context && "room" in context && context.room) {
      return `${context.room}/${document}`;
    }
    return document;
  }

  /**
   * Create or get a session for a document.
   * @param documentId - The ID of the document.
   * @param encrypted - Whether the document is encrypted.
   * @param id - The ID of the session.
   * @param context - Optional context containing room information for multi-tenancy.
   * @returns The session.
   */
  async getOrOpenSession(
    documentId: string | undefined,
    {
      encrypted,
      id = "session-" + uuidv4(),
      client,
      context,
    }: {
      encrypted: boolean;
      id?: string;
      client?: Client<Context>;
      context: Context;
    },
  ) {
    if (!documentId) {
      throw new Error("Document ID is required");
    }

    const logger = getLogger(["teleportal", "server"]);
    const compositeDocumentId = this.#getCompositeDocumentId(
      documentId,
      context,
    );

    // Check if session already exists
    const existing = this.#sessions.get(compositeDocumentId);
    if (existing) {
      // Validate that the encryption state matches the existing session
      if (existing.encrypted !== encrypted) {
        const error = new Error(
          `Encryption state mismatch: existing session for document "${compositeDocumentId}" has encrypted=${existing.encrypted}, but requested encrypted=${encrypted}`,
        );
        logger.error("Encryption state mismatch detected", {
          documentId: compositeDocumentId,
          sessionId: existing.id,
          existingEncrypted: existing.encrypted,
          requestedEncrypted: encrypted,
          error: toErrorDetails(error),
        });
        throw error;
      }

      logger.debug("Retrieved existing session", {
        documentId: compositeDocumentId,
        sessionId: existing.id,
        encrypted,
      });

      if (client) {
        existing.addClient(client);
      }

      return existing;
    }

    // Check if there's a pending session creation for this document
    const pending = this.#pendingSessions.get(compositeDocumentId);
    if (pending) {
      logger.debug("Waiting for pending session creation", {
        documentId: compositeDocumentId,
      });

      const session = await pending;

      // Validate encryption state matches
      if (session.encrypted !== encrypted) {
        const error = new Error(
          `Encryption state mismatch: pending session for document "${compositeDocumentId}" has encrypted=${session.encrypted}, but requested encrypted=${encrypted}`,
        );
        logger.error("Encryption state mismatch detected", {
          documentId: compositeDocumentId,
          sessionId: session.id,
          existingEncrypted: session.encrypted,
          requestedEncrypted: encrypted,
          error: toErrorDetails(error),
        });
        throw error;
      }

      if (client) {
        session.addClient(client);
      }

      return session;
    }

    // Create a new session - wrap in a promise to prevent race conditions
    const sessionLogger = logger.with({
      documentId: compositeDocumentId,
      sessionId: id,
      encrypted,
    });

    sessionLogger.info("Creating new session", {
      documentId: compositeDocumentId,
      sessionId: id,
      encrypted,
    });

    const sessionPromise = (async (): Promise<Session<Context>> => {
      try {
        const storage = await (typeof this.#options.storage === "function"
          ? this.#options.storage({
              documentId: compositeDocumentId,
              context,
              encrypted,
            })
          : this.#options.storage);

        sessionLogger.debug("Storage retrieved for session");

        const session = new Session<Context>({
          documentId,
          namespacedDocumentId: compositeDocumentId,
          id,
          encrypted,
          storage,
          pubSub: this.pubSub,
          nodeId: this.#nodeId,
          onCleanupScheduled: this.#handleSessionCleanup.bind(this),
          metricsCollector: this.#metrics,
          documentSizeConfig: this.#options.documentSizeConfig,
          rpcHandlers: this.#options.rpcHandlers,
          server: this,
        });

        await session.load();
        this.#sessions.set(compositeDocumentId, session);

        // Record session creation metrics
        this.#metrics.sessionsActive.inc();
        this.#metrics.documentsOpenedTotal.inc();

        // Record initial document size metric
        try {
          const meta = await storage.getDocumentMetadata(compositeDocumentId);
          if (meta.sizeBytes !== undefined) {
            this.#metrics.recordDocumentSize(
              compositeDocumentId,
              meta.sizeBytes,
              encrypted,
            );
          }
        } catch (error) {
          sessionLogger.warn("Failed to record initial document size metric", {
            error: toErrorDetails(error as Error),
          });
        }

        sessionLogger
          .with({
            documentId: compositeDocumentId,
            sessionId: id,
            encrypted,
            totalSessions: this.#sessions.size,
          })
          .info("Session created and loaded");

        await this.call("document-load", {
          documentId,
          namespacedDocumentId: compositeDocumentId,
          sessionId: id,
          encrypted,
          context,
        });

        await this.call("session-open", {
          session,
          documentId,
          namespacedDocumentId: compositeDocumentId,
          encrypted,
          context,
        });

        return session;
      } catch (error) {
        sessionLogger
          .with({
            error: toErrorDetails(error as Error),
            documentId: compositeDocumentId,
            sessionId: id,
            encrypted,
          })
          .error("Failed to create session");
        throw error;
      } finally {
        // Always remove from pending map, even on error
        this.#pendingSessions.delete(compositeDocumentId);
      }
    })();

    // Store the promise so concurrent calls can wait for it
    this.#pendingSessions.set(compositeDocumentId, sessionPromise);

    const session = await sessionPromise;

    if (client) {
      session.addClient(client);
    }

    return session;
  }

  /**
   * Deletes a document and its associated data (files, sessions, etc.).
   * @param documentId - The ID of the document to delete.
   * @param context - Optional context for document ID resolution.
   */
  async deleteDocument(
    documentId: string,
    context: Context,
    encrypted: boolean,
  ): Promise<void> {
    const logger = getLogger(["teleportal", "server"]);
    const compositeDocumentId = this.#getCompositeDocumentId(
      documentId,
      context,
    );

    logger
      .with({
        documentId: compositeDocumentId,
        encrypted,
      })
      .info("Deleting document");

    // Close existing session if any
    const session = this.#sessions.get(compositeDocumentId);
    let storage = session?.storage;
    if (session) {
      // Disconnect all clients
      storage = session.storage;

      this.call("document-unload", {
        documentId: session.documentId,
        namespacedDocumentId: session.namespacedDocumentId,
        sessionId: session.id,
        encrypted: session.encrypted,
        reason: "delete",
      });

      await session[Symbol.asyncDispose]();
      this.#sessions.delete(compositeDocumentId);
    } else {
      // Reload the storage instance directly to delete document
      storage = await (typeof this.#options.storage === "function"
        ? this.#options.storage({
            documentId: compositeDocumentId,
            context,
            encrypted,
          })
        : this.#options.storage);
    }

    // Wait for any pending session creation
    const pending = this.#pendingSessions.get(compositeDocumentId);
    if (pending) {
      try {
        const pendingSession = await pending;

        this.call("document-unload", {
          documentId: pendingSession.documentId,
          namespacedDocumentId: pendingSession.namespacedDocumentId,
          sessionId: pendingSession.id,
          encrypted: pendingSession.encrypted,
          reason: "delete",
        });

        await pendingSession[Symbol.asyncDispose]();
      } catch {
        // Ignore errors from pending session
      }
      this.#pendingSessions.delete(compositeDocumentId);
    }

    // Delete document data via storage (this handles cascade deletion of files)
    await storage.deleteDocument(compositeDocumentId);

    this.call("document-delete", {
      documentId,
      namespacedDocumentId: compositeDocumentId,
      encrypted,
      context,
    });

    logger
      .with({
        documentId: compositeDocumentId,
      })
      .info("Document deleted");
  }

  /**
   * Create a client for a transport.
   * @param ctx - Context Object
   * @param ctx.transport - The transport to use for the client.
   * @param id - The ID of the client.
   * @param abortSignal - When the signal is aborted, the client will be removed from the server
   * @returns The client.
   */
  createClient({
    transport,
    id = "client-" + uuidv4(),
    abortSignal,
  }: {
    transport: Transport<Context>;
    id?: string;
    abortSignal?: AbortSignal;
  }) {
    const logger = getLogger(["teleportal", "server"]).with({ clientId: id });

    logger.info("Creating new client");

    // Apply rate limiting if configured
    let rateLimitedTransport = transport;
    if (this.#options.rateLimitConfig) {
      const config = this.#options.rateLimitConfig;

      // Build rules with default getUserId/getDocumentId if not provided
      const rules = config.rules.map((rule) => ({
        ...rule,
        getUserId:
          rule.getUserId ?? config.getUserId ?? ((msg) => msg.context?.userId),
        getDocumentId:
          rule.getDocumentId ?? config.getDocumentId ?? ((msg) => msg.document),
      }));

      rateLimitedTransport = withRateLimit(transport, {
        rules,
        maxMessageSize: config.maxMessageSize,
        rateLimitStorage: config.rateLimitStorage,
        getUserId: config.getUserId ?? ((msg) => msg.context.userId),
        getDocumentId: config.getDocumentId ?? ((msg) => msg.document),
        shouldSkipRateLimit: async (message) => {
          // Use custom skip function if provided
          if (config.shouldSkipRateLimit) {
            const shouldSkip = await config.shouldSkipRateLimit(message);
            if (shouldSkip) return true;
          }
          // Skip rate limiting for ACK messages
          if (message.type === "ack") {
            return true;
          }
          return false;
        },
        onRateLimitExceeded: config.onRateLimitExceeded,
        onMessageSizeExceeded: config.onMessageSizeExceeded,
        metricsCollector: this.#metrics,
        eventEmitter: this as any,
      });

      logger.debug("Rate limiting applied to transport", {
        ruleCount: rules.length,
        hasStorage: !!config.rateLimitStorage,
      });
    }

    const client = new Client<Context>({
      id,
      writable: rateLimitedTransport.writable,
    });

    withMessageValidator(rateLimitedTransport, {
      isAuthorized: async (message, type) => {
        if (!this.#options.checkPermission) {
          logger
            .with({
              messageId: message.id,
              documentId: message.document,
              messageType: message.type,
              permissionType: type,
            })
            .debug("No permission checker configured, allowing message");
          return true;
        }

        const msgLogger = logger.with({ messageId: message.id });

        // Skip permission check for ACK messages (they're acknowledgments, not requests)
        if (message.type === "ack") {
          msgLogger.debug("Skipping permission check for ACK message");
          return true;
        }

        // Extract fileId from RPC stream message (file-part) if document is undefined
        const fileId =
          message.type === "rpc" &&
          (message as RpcMessage<Context>).requestType === "stream" &&
          (message as RpcMessage<Context>).payload.type === "success"
            ? ((message as RpcMessage<Context>).payload.payload as any)?.fileId
            : undefined;

        msgLogger
          .with({
            messageId: message.id,
            documentId: message.document,
            fileId,
            messageType: message.type,
            permissionType: type,
            userId: message.context.userId,
            clientId: message.context.clientId,
          })
          .debug("Checking permission");

        try {
          // Ensure at least one of documentId or fileId is provided
          if (!message.document && !fileId) {
            throw new Error(
              `Message ${message.id} must have either documentId or fileId`,
            );
          }

          const ok = await this.#options.checkPermission({
            context: message.context,
            documentId: message.document ?? undefined,
            fileId,
            message,
            type,
          });

          msgLogger
            .with({
              messageId: message.id,
              documentId: message.document,
              fileId,
              permissionType: type,
              authorized: ok,
            })
            .trace(ok ? "Message authorized" : "Message denied");

          if (!ok) {
            if (
              message.type === "doc" &&
              message.payload.type === "sync-step-2"
            ) {
              msgLogger.debug(
                "Client tried to send sync-step-2 message but doesn't have write permissions, dropping message",
              );
              // Tell the client that they've successfully synced their state vector
              await client.send(
                new DocMessage(
                  message.document,
                  { type: "sync-done" },
                  message.context,
                  message.encrypted,
                ),
              );
              return false;
            }

            if (message.type === "rpc") {
              await client.send(
                new RpcMessage<Context>(
                  message.document,
                  {
                    type: "error",
                    statusCode: 403,
                    details: "Permission denied for file upload",
                  },
                  message.rpcMethod,
                  "response",
                  message.originalRequestId ?? message.id,
                  message.context,
                  message.encrypted,
                ),
              );
              return false;
            }

            if (!message.document) {
              // just ignore this message (it's an ack message)
              return false;
            }

            // Otherwise, send a doc-auth-message
            await client.send(
              new DocMessage(
                message.document,
                {
                  type: "auth-message",
                  permission: "denied",
                  reason: `Insufficient permissions to access document ${message.document}`,
                },
                message.context,
                message.encrypted,
              ),
            );
            return false;
          }
          return true;
        } catch (error) {
          console.log(error);
          msgLogger
            .with({
              error: toErrorDetails(error as Error),
              messageId: message.id,
              documentId: message.document,
              permissionType: type,
            })
            .error("Permission check failed");
          return false;
        }
      },
    })
      .readable.pipeTo(
        new WritableStream<Message<Context>>({
          write: async (message) => {
            if (message.type === "ack") {
              // client ack'd, we don't care about it for processing
              // but still track it in metrics
              this.#metrics.incrementMessage(message.type);
              return;
            }

            const msgLogger = logger.with({
              messageId: message.id,
              documentId: message.document,
            });

            msgLogger
              .with({
                messageId: message.id,
                documentId: message.document,
                messageType: message.type,
                encrypted: message.encrypted,
                payloadType: (message as any).payload?.type,
              })
              .debug("Processing incoming message");

            try {
              const session = await this.getOrOpenSession(message.document, {
                encrypted: message.encrypted,
                client,
                context: message.context,
              });

              msgLogger.debug("Client added to session, applying message");

              const startTime = Date.now();
              await session.apply(message, client);
              const duration = (Date.now() - startTime) / 1000;

              // Record message metrics
              this.#metrics.incrementMessage(message.type);
              this.#metrics.messageDuration.observe(
                { type: message.type },
                duration,
              );

              msgLogger
                .with({
                  messageId: message.id,
                  documentId: message.document,
                })
                .debug("Message applied successfully");

              // Emit client-message event for metrics/webhooks
              this.call("client-message", {
                clientId: client.id,
                messageId: message.id,
                documentId: message.document,
                messageType: message.type,
                payloadType: (message as any).payload?.type,
                encrypted: message.encrypted,
                context: message.context,
                direction: "in",
              });

              // Send ACK for all non-ACK messages after successful processing

              const ackMessage = new AckMessage(
                {
                  type: "ack",
                  messageId: message.id,
                },
                message.context,
              );

              await client.send(ackMessage);
              // Publish ACK to pubsub topic if it's not a client-to-client message
              await this.pubSub.publish(
                `ack/${client.id}` as const,
                ackMessage.encoded,
                `server-${client.id}`,
              );

              msgLogger
                .with({
                  messageId: message.id,
                  ackMessageId: ackMessage.id,
                })
                .trace("Sent ACK for message");
            } catch (error) {
              msgLogger
                .with({
                  error: toErrorDetails(error as Error),
                  messageId: message.id,
                  documentId: message.document,
                  messageType: message.type,
                })
                .error("Failed to process message");
              throw error;
            }
          },
        }),
      )
      .catch((err) => {
        logger
          .with({ error: toErrorDetails(err), clientId: id })
          .error("Client stream errored");
      })
      .finally(() => {
        logger
          .with({ clientId: id })
          .info("Client stream ended, disconnecting client");
        this.disconnectClient(client.id, "stream-ended");
      });

    logger.with({ clientId: id }).info("Client created and connected");

    // Record client connect metric
    this.#metrics.clientsActive.inc();

    this.call("client-connect", { clientId: id });

    if (abortSignal) {
      abortSignal.addEventListener("abort", () => {
        this.disconnectClient(client.id, "abort");
      });
    }

    return client;
  }

  /**
   * Disconnect a client from all sessions.
   * @param client - The client or client ID to disconnect.
   * @param reason - The reason for disconnection.
   */
  disconnectClient(
    client: string | Client<Context>,
    reason: ClientDisconnectReason = "manual",
  ) {
    const clientId = typeof client === "string" ? client : client.id;
    const logger = getLogger(["teleportal", "server"]).with({ clientId });

    logger
      .with({ clientId, reason })
      .info("Disconnecting client from all sessions");

    for (const s of this.#sessions.values()) {
      s.removeClient(client);
    }

    logger
      .with({
        clientId,
        reason,
        totalSessions: this.#sessions.size,
      })
      .info("Client disconnected from sessions");

    // Record client disconnect metric
    this.#metrics.clientsActive.dec();

    this.call("client-disconnect", { clientId, reason });
  }

  /**
   * Handle cleanup of a session that was scheduled for disposal.
   */
  #handleSessionCleanup(session: Session<Context>) {
    const logger = getLogger(["teleportal", "server"]);
    // Check if session still exists in our map (using namespacedDocumentId as key)
    const existingSession = this.#sessions.get(session.namespacedDocumentId);
    if (!existingSession || existingSession !== session) {
      // Session was already removed or replaced
      return;
    }

    // Verify session should still be disposed (has no clients)
    if (session.shouldDispose) {
      logger
        .with({
          documentId: session.documentId,
          namespacedDocumentId: session.namespacedDocumentId,
          sessionId: session.id,
        })
        .info("Cleaning up session with no clients");

      this.call("document-unload", {
        documentId: session.documentId,
        namespacedDocumentId: session.namespacedDocumentId,
        sessionId: session.id,
        encrypted: session.encrypted,
        reason: "cleanup",
      });

      this.#sessions.delete(session.namespacedDocumentId);

      // Record session cleanup metric
      this.#metrics.sessionsActive.dec();

      session[Symbol.asyncDispose]().catch((error) => {
        logger
          .with({
            error: toErrorDetails(error as Error),
            documentId: session.documentId,
            namespacedDocumentId: session.namespacedDocumentId,
            sessionId: session.id,
          })
          .error("Error disposing session during cleanup");
      });
    }
  }

  /**
   * Async dispose the server.
   */
  async [Symbol.asyncDispose](): Promise<void> {
    const logger = getLogger(["teleportal", "server"]);
    logger
      .with({
        nodeId: this.#nodeId,
        activeSessions: this.#sessions.size,
        pendingSessions: this.#pendingSessions.size,
      })
      .info("Disposing server");

    this.call("before-server-shutdown", {
      nodeId: this.#nodeId,
      activeSessions: this.#sessions.size,
      pendingSessions: this.#pendingSessions.size,
    });

    // Call handler cleanup functions
    for (const cleanup of this.#handlerCleanups) {
      cleanup();
    }
    this.#handlerCleanups = [];

    // Wait for any pending session creations to complete (or fail)
    // This prevents dangling promises and ensures we don't dispose while sessions are being created
    if (this.#pendingSessions.size > 0) {
      logger
        .with({
          pendingCount: this.#pendingSessions.size,
        })
        .debug("Waiting for pending session creations to complete");

      await Promise.allSettled(
        [...this.#pendingSessions.values()].map(async (promise) => {
          try {
            await promise;
          } catch {
            // Ignore errors from pending session creation - they're expected if creation fails
          }
        }),
      );

      this.#pendingSessions.clear();
    }

    for (const s of this.#sessions.values()) {
      this.call("document-unload", {
        documentId: s.documentId,
        namespacedDocumentId: s.namespacedDocumentId,
        sessionId: s.id,
        encrypted: s.encrypted,
        reason: "dispose",
      });

      try {
        await s[Symbol.asyncDispose]();
      } catch (error) {
        logger
          .with({
            error: toErrorDetails(error as Error),
            sessionId: s.id,
            documentId: s.documentId,
          })
          .error("Error disposing session");
      }
    }

    try {
      await this.pubSub[Symbol.asyncDispose]?.();
    } catch (error) {
      logger
        .with({ error: toErrorDetails(error as Error) })
        .error("Error disposing pubSub");
    }

    this.call("after-server-shutdown", {
      nodeId: this.#nodeId,
    });

    logger
      .with({
        nodeId: this.#nodeId,
      })
      .info("Server disposed");
  }

  /**
   * Get Prometheus-formatted metrics.
   */
  async getMetrics(): Promise<string> {
    return register.format();
  }

  /**
   * Get the metrics collector instance.
   * Useful for testing and advanced configuration.
   */
  getMetricsCollector(): MetricsCollector {
    return this.#metrics;
  }

  /**
   * Perform health checks and return status.
   */
  async getHealth(): Promise<HealthStatus> {
    const checks: Record<string, "healthy" | "unhealthy" | "unknown"> = {};
    const overallStatus: "healthy" | "unhealthy" = "healthy";

    return {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      checks,
      uptime: Math.floor((Date.now() - this.#startTime) / 1000),
    };
  }

  /**
   * Get current operational status.
   */
  async getStatus(): Promise<StatusData> {
    // Count total clients across all sessions
    const activeClients = [...this.#sessions.values()].reduce(
      (total, session) => total + [...session.clients].length,
      0,
    );

    // Get total messages processed from metrics
    const totalMessagesProcessed =
      this.#metrics.totalMessagesProcessed.getValue();

    // Calculate size statistics
    let totalDocumentSizeBytes = 0;
    let documentsOverWarningThreshold = 0;
    let documentsOverLimit = 0;

    const documentSizes = this.#metrics.documentSizeBytes.getValues();
    const warningThreshold = this.#options.documentSizeConfig?.warningThreshold;
    const limit = this.#options.documentSizeConfig?.limit;

    for (const { value } of documentSizes) {
      totalDocumentSizeBytes += value;
      if (warningThreshold && value >= warningThreshold) {
        documentsOverWarningThreshold++;
      }
      if (limit && value > limit) {
        documentsOverLimit++;
      }
    }

    return {
      nodeId: this.#nodeId,
      activeClients,
      activeSessions: this.#sessions.size,
      pendingSessions: this.#pendingSessions.size,
      totalMessagesProcessed,
      totalDocumentsOpened: this.#metrics.documentsOpenedTotal.getValue(),
      messageTypeBreakdown: this.#metrics.getMessageCountsByType(),
      rateLimitExceededTotal: this.#metrics.rateLimitExceededTotal.getValue(),
      rateLimitBreakdown: this.#metrics.getRateLimitCountsByTrackBy(),
      rateLimitTopOffenders: this.#metrics.getRateLimitTopOffenders(),
      rateLimitRecentEvents: this.#metrics.getRateLimitRecentEvents(),
      uptime: Math.floor((Date.now() - this.#startTime) / 1000),
      timestamp: new Date().toISOString(),
      totalDocumentSizeBytes,
      documentsOverWarningThreshold,
      documentsOverLimit,
    };
  }

  toString() {
    return `Server(nodeId: ${this.#nodeId}, activeSessions: ${this.#sessions
      .values()
      .map((s) => s.toString())
      .toArray()
      .join(", ")})`;
  }

  toJSON() {
    return {
      nodeId: this.#nodeId,
      activeSessions: this.#sessions
        .values()
        .map((s) => s.toJSON())
        .toArray(),
    };
  }
}
