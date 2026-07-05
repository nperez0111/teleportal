import { uuidv4 } from "lib0/random";
import { emitWideEvent, type WideEvent } from "./logger";
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
import { HealthStatus, MetricsCollector, StatusData } from "teleportal/monitoring";
import type { RpcHandlerRegistry } from "teleportal/protocol";
import type { DocumentStorage, MilestoneTrigger, RateLimitStorage } from "teleportal/storage";
import { forEachMessage, withMessageValidator } from "teleportal/transports";
import { type RateLimitRule, withRateLimit } from "teleportal/transports/rate-limiter";
import { Observable } from "../lib/utils";
import { register } from "../monitoring/metrics";
import { Client } from "./client";
import type {
  AttributionConfig,
  ClientDisconnectReason,
  PresenceConfig,
  ServerEvents,
} from "./events";
import { Session } from "./session";

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
    rpcMethod?: string;
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
   * Configuration for client presence (join/leave) notifications broadcast to
   * a session's peers.
   */
  presenceConfig?: PresenceConfig<NoInfer<Context>>;

  /**
   * Configuration for custom attribution metadata on document updates.
   */
  attributionConfig?: AttributionConfig<NoInfer<Context>>;

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
     * Maximum time (ms) to hold a rate-limited inbound message while its
     * bucket refills before dropping it (and nacking the sender). Holding
     * slows a fast client to the allowed rate without losing messages.
     * Set to 0 to drop immediately.
     * @default 1000
     */
    maxDelayMs?: number;

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
    shouldSkipRateLimit?: (message: Message<NoInfer<Context>>) => Promise<boolean> | boolean;

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
     * Called after a message was held by flow control and then delivered
     * (rate limiting engaged without dropping anything). The signal to watch
     * when clients feel throttled but no messages are lost.
     */
    onRateLimitDelay?: (details: {
      ruleId: string;
      userId?: string;
      documentId?: string;
      trackBy: string;
      delayMs: number;
      maxMessages: number;
      windowMs: number;
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

export class Server<Context extends ServerContext> extends Observable<ServerEvents<Context>> {
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
   * Composite document IDs whose session's encryption mode was set by
   * non-authoritative metadata (rpc/presence) creating the session. The
   * first authoritative doc/awareness message either locks the mode in or
   * corrects it by recreating the session — see {@link getOrOpenSession}.
   */
  #tentativeEncryptionSessions = new Set<string>();
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

    emitWideEvent("info", {
      event_type: "server_initialized",
      timestamp: new Date().toISOString(),
      node_id: this.#nodeId,
      has_custom_pub_sub: !!options.pubSub,
      has_permission_checker: !!options.checkPermission,
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
      // Encrypted by default — callers that omit it open an encrypted session.
      encrypted = true,
      id = "session-" + uuidv4(),
      client,
      context,
      encryptionAuthoritative = true,
    }: {
      encrypted?: boolean;
      id?: string;
      client?: Client<Context>;
      context: Context;
      /**
       * Whether this caller's `encrypted` flag is allowed to DEFINE the
       * document's encryption mode. Doc and awareness traffic is
       * authoritative (their flag is a property of the document's content).
       * Metadata (rpc, presence — whose flag describes the message payload,
       * not the document) is not: it attaches to whatever session exists
       * without validation, and a session it CREATES is only tentative —
       * the first authoritative message corrects the mode by recreating the
       * session. Without this, a key-registry RPC or presence announce
       * racing ahead of the first doc message poisoned the session with
       * encrypted=false, after which every doc/awareness message failed
       * with encryption_mismatch until the session died.
       */
      encryptionAuthoritative?: boolean;
    },
  ) {
    if (!documentId) {
      throw new Error("Document ID is required");
    }

    const compositeDocumentId = this.#getCompositeDocumentId(documentId, context);

    // If a session creation is already in flight, wait for it to settle and
    // fall through to the existing-session handling below (a rejected
    // creation simply means we create fresh).
    const pending = this.#pendingSessions.get(compositeDocumentId);
    if (pending) {
      await pending.then(
        () => {},
        () => {},
      );
    }

    const existing = this.#sessions.get(compositeDocumentId);
    if (existing) {
      if (existing.encrypted === encrypted) {
        // Matching authoritative traffic locks the mode in.
        if (encryptionAuthoritative) {
          this.#tentativeEncryptionSessions.delete(compositeDocumentId);
        }
        if (client) {
          existing.addClient(client);
        }
        return existing;
      }

      if (!encryptionAuthoritative) {
        // Metadata attaches to the session regardless of its mode and never
        // (re)defines it.
        if (client) {
          existing.addClient(client);
        }
        return existing;
      }

      if (this.#tentativeEncryptionSessions.has(compositeDocumentId)) {
        // The session's mode was set by metadata that raced ahead of the
        // first doc message; this caller is authoritative. Correct the mode
        // by recreating the session instead of failing every doc message.
        emitWideEvent("info", {
          event_type: "encryption_mode_corrected",
          timestamp: new Date().toISOString(),
          document_id: compositeDocumentId,
          session_id: existing.id,
          tentative_encrypted: existing.encrypted,
          corrected_encrypted: encrypted,
        });
        this.#tentativeEncryptionSessions.delete(compositeDocumentId);
        this.#sessions.delete(compositeDocumentId);
        this.#metrics.sessionsActive.dec();
        try {
          await existing[Symbol.asyncDispose]();
        } catch (error) {
          emitWideEvent("error", {
            event_type: "session_dispose_error",
            timestamp: new Date().toISOString(),
            document_id: compositeDocumentId,
            session_id: existing.id,
            error,
          });
        }
        // Fall through to create the session with the authoritative mode.
      } else {
        const error = new Error(
          `Encryption state mismatch: existing session for document "${compositeDocumentId}" has encrypted=${existing.encrypted}, but requested encrypted=${encrypted}`,
        );
        emitWideEvent("error", {
          event_type: "encryption_mismatch",
          timestamp: new Date().toISOString(),
          document_id: compositeDocumentId,
          session_id: existing.id,
          existing_encrypted: existing.encrypted,
          requested_encrypted: encrypted,
          error,
        });
        throw error;
      }
    }

    // Create a new session - wrap in a promise to prevent race conditions
    const sessionPromise = (async (): Promise<Session<Context>> => {
      try {
        const storage = await (typeof this.#options.storage === "function"
          ? this.#options.storage({
              documentId: compositeDocumentId,
              context,
              encrypted,
            })
          : this.#options.storage);

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
          presenceConfig: this.#options.presenceConfig,
          attributionConfig: this.#options.attributionConfig,
          rpcHandlers: this.#options.rpcHandlers,
          server: this,
        });

        await session.load();
        this.#sessions.set(compositeDocumentId, session);
        // Mark tentative inside the creation promise (not after awaiting it)
        // so a concurrent authoritative caller that awaited the pending
        // creation observes the flag.
        if (!encryptionAuthoritative) {
          this.#tentativeEncryptionSessions.add(compositeDocumentId);
        }

        // Record session creation metrics
        this.#metrics.sessionsActive.inc();
        this.#metrics.documentsOpenedTotal.inc();

        // Record initial document size metric
        try {
          const meta = await storage.getDocumentMetadata(compositeDocumentId);
          if (meta.sizeBytes !== undefined) {
            this.#metrics.recordDocumentSize(compositeDocumentId, meta.sizeBytes, encrypted);
          }
        } catch (error) {
          emitWideEvent("info", {
            event_type: "document_size_metric_failed",
            timestamp: new Date().toISOString(),
            document_id: compositeDocumentId,
            session_id: id,
            encrypted,
            error,
          });
        }

        emitWideEvent("info", {
          event_type: "session_created",
          timestamp: new Date().toISOString(),
          document_id: compositeDocumentId,
          session_id: id,
          encrypted,
          total_sessions: this.#sessions.size,
        });

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
        emitWideEvent("error", {
          event_type: "session_creation_failed",
          timestamp: new Date().toISOString(),
          document_id: compositeDocumentId,
          session_id: id,
          encrypted,
          error,
        });
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
  async deleteDocument(documentId: string, context: Context, encrypted: boolean): Promise<void> {
    const compositeDocumentId = this.#getCompositeDocumentId(documentId, context);

    emitWideEvent("info", {
      event_type: "document_delete_start",
      timestamp: new Date().toISOString(),
      document_id: compositeDocumentId,
      encrypted,
    });

    // Close existing session if any
    const session = this.#sessions.get(compositeDocumentId);
    let storage = session?.storage;
    if (session) {
      await this.call("document-unload", {
        documentId: session.documentId,
        namespacedDocumentId: session.namespacedDocumentId,
        sessionId: session.id,
        encrypted: session.encrypted,
        reason: "delete",
      });

      await session[Symbol.asyncDispose]();
      this.#sessions.delete(compositeDocumentId);
      this.#tentativeEncryptionSessions.delete(compositeDocumentId);
      this.#metrics.sessionsActive.dec();
    } else {
      // Resolve the storage instance directly to delete the document
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

        await this.call("document-unload", {
          documentId: pendingSession.documentId,
          namespacedDocumentId: pendingSession.namespacedDocumentId,
          sessionId: pendingSession.id,
          encrypted: pendingSession.encrypted,
          reason: "delete",
        });

        await pendingSession[Symbol.asyncDispose]();
        this.#sessions.delete(compositeDocumentId);
        this.#metrics.sessionsActive.dec();
      } catch {
        // Ignore errors from pending session
      }
      this.#pendingSessions.delete(compositeDocumentId);
    }

    // Delete document data via storage (this handles cascade deletion of files)
    await storage!.deleteDocument(compositeDocumentId);

    await this.call("document-delete", {
      documentId,
      namespacedDocumentId: compositeDocumentId,
      encrypted,
      context,
    });

    emitWideEvent("info", {
      event_type: "document_deleted",
      timestamp: new Date().toISOString(),
      document_id: compositeDocumentId,
    });
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
    emitWideEvent("info", {
      event_type: "client_connect",
      timestamp: new Date().toISOString(),
      client_id: id,
    });

    // Apply rate limiting if configured
    let rateLimitedTransport = transport;
    if (this.#options.rateLimitConfig) {
      const config = this.#options.rateLimitConfig;

      // Build rules with default getUserId/getDocumentId if not provided
      const rules = config.rules.map((rule) => ({
        ...rule,
        getUserId: rule.getUserId ?? config.getUserId ?? ((msg) => msg.context?.userId),
        getDocumentId: rule.getDocumentId ?? config.getDocumentId ?? ((msg) => msg.document),
      }));

      rateLimitedTransport = withRateLimit(transport, {
        rules,
        maxMessageSize: config.maxMessageSize,
        maxDelayMs: config.maxDelayMs,
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
        onRateLimitExceeded: (details) => {
          emitWideEvent("error", {
            event_type: "rate_limit_exceeded",
            timestamp: new Date().toISOString(),
            rule_id: details.ruleId,
            user_id: details.userId,
            document_id: details.documentId,
            track_by: details.trackBy,
            max_messages: details.maxMessages,
            window_ms: details.windowMs,
            reset_at: details.resetAt,
            message_type: details.message.type,
            rpc_method:
              details.message.type === "rpc"
                ? (details.message as RpcMessage<any>).rpcMethod
                : undefined,
          });
          config.onRateLimitExceeded?.(details);
        },
        onRateLimitDelay: (details) => {
          emitWideEvent("info", {
            event_type: "rate_limit_delayed",
            timestamp: new Date().toISOString(),
            rule_id: details.ruleId,
            user_id: details.userId,
            document_id: details.documentId,
            track_by: details.trackBy,
            delay_ms: details.delayMs,
            max_messages: details.maxMessages,
            window_ms: details.windowMs,
            message_type: details.message.type,
          });
          config.onRateLimitDelay?.(details);
        },
        onRateLimitDrop: (message, exceeded, write) => {
          // resetAt is when the next token refills — retryAfter must never
          // fall back to the full window (10s for the default per-document
          // rule), which reads as a multi-second ack stall on the client.
          const retryAfter = Math.max(1, exceeded.resetAt - Date.now());
          Promise.resolve(
            write(
              new AckMessage({
                type: "ack",
                messageId: message.id,
                retryAfter,
              }),
            ),
          ).catch(() => {});
        },
        onMessageSizeExceeded: config.onMessageSizeExceeded,
        metricsCollector: this.#metrics,
        eventEmitter: this as any,
      });
    }

    const client = new Client<Context>({
      id,
      write: (msg) => rateLimitedTransport.write(msg),
    });

    client.on("client-message", (ctx) => {
      this.call("client-message", ctx);
    });

    const validatedTransport = withMessageValidator(rateLimitedTransport, {
      isAuthorized: async (message, type) => {
        if (!this.#options.checkPermission) {
          return true;
        }

        // Skip permission check for ACK messages (they're acknowledgments, not requests)
        if (message.type === "ack") {
          return true;
        }

        // Extract fileId from RPC stream message (file-part) if document is undefined
        const fileId =
          message.type === "rpc" &&
          (message as RpcMessage<Context>).requestType === "stream" &&
          (message as RpcMessage<Context>).payload.type === "success"
            ? ((message as RpcMessage<Context>).payload.payload as any)?.fileId
            : undefined;

        try {
          // Ensure at least one of documentId or fileId is provided
          if (!message.document && !fileId) {
            throw new Error(`Message ${message.id} must have either documentId or fileId`);
          }

          const ok = await this.#options.checkPermission({
            context: message.context,
            documentId: message.document ?? undefined,
            fileId,
            message,
            type,
            rpcMethod:
              message.type === "rpc" ? (message as RpcMessage<Context>).rpcMethod : undefined,
          });

          if (!ok) {
            if (message.type === "doc" && message.payload.type === "sync-step-2") {
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
                    details: "Permission denied",
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
          emitWideEvent("error", {
            event_type: "permission_check_failed",
            timestamp: new Date().toISOString(),
            message_id: message.id,
            document_id: message.document,
            permission_type: type,
            error,
          });
          return false;
        }
      },
    });

    // Consume validated transport source
    (async () => {
      try {
        await forEachMessage(validatedTransport.source, async (message) => {
          if (message.type === "ack") {
            this.#metrics.incrementMessage(message.type);
            return;
          }

          // Fast path for RPC stream messages (file chunks): skip wideEvent
          // construction, metrics observation, and event dispatch. The ACK is
          // still published over pubsub like every other message so it reaches
          // the client when its connection lives on a different server node.
          if (message.type === "rpc" && (message as RpcMessage<Context>).requestType === "stream") {
            try {
              const session = await this.getOrOpenSession(message.document, {
                encrypted: message.encrypted,
                client,
                context: message.context,
                encryptionAuthoritative: false,
              });
              await session.apply(message, client);
              this.#metrics.incrementMessage(message.type);
              const ackMessage = new AckMessage(
                { type: "ack", messageId: message.id },
                message.context,
              );
              await client.send(ackMessage);
              await this.pubSub.publish(
                `ack/${client.id}` as const,
                ackMessage.encoded,
                `server-${client.id}`,
              );
            } catch (error) {
              await this.#nackFailedMessage(client, message, error);
            }
            return;
          }

          const startTime = Date.now();
          const wideEvent: WideEvent = {
            event_type: "message",
            timestamp: new Date().toISOString(),
            message_id: message.id,
            client_id: client.id,
            document_id: message.document,
            message_type: message.type,
            payload_type: (message as { payload?: { type?: string } }).payload?.type,
            encrypted: message.encrypted,
            user_id: message.context?.userId,
          };

          try {
            const session = await this.getOrOpenSession(message.document, {
              encrypted: message.encrypted,
              client,
              context: message.context,
              // Doc/awareness flags describe the document's content and may
              // define the session's mode; rpc/presence flags describe only
              // the message payload and may not.
              encryptionAuthoritative: message.type !== "presence" && message.type !== "rpc",
            });
            wideEvent.session_id = session.id;

            await session.apply(message, client);

            this.#metrics.incrementMessage(message.type);
            const durationSec = (Date.now() - startTime) / 1000;
            this.#metrics.messageDuration.observe({ type: message.type }, durationSec);

            this.call("client-message", {
              clientId: client.id,
              message,
              direction: "in",
            });

            const ackMessage = new AckMessage(
              {
                type: "ack",
                messageId: message.id,
              },
              message.context,
            );
            await client.send(ackMessage);
            await this.pubSub.publish(
              `ack/${client.id}` as const,
              ackMessage.encoded,
              `server-${client.id}`,
            );

            wideEvent.outcome = "success";
            wideEvent.status_code = 200;
          } catch (error) {
            wideEvent.outcome = "error";
            wideEvent.status_code = 500;
            wideEvent.error = error;
            // A single bad message must not tear down the connection: nack it
            // with the reason and keep consuming. Rethrowing here would end
            // the consume loop while the socket stays open — the client would
            // silently stop receiving acks and broadcasts.
            await this.#nackFailedMessage(client, message, error);
          } finally {
            wideEvent.duration_ms = Date.now() - startTime;
            emitWideEvent(wideEvent.outcome === "error" ? "error" : "info", wideEvent);
          }
        });
      } catch (err) {
        emitWideEvent("error", {
          event_type: "client_stream_error",
          timestamp: new Date().toISOString(),
          client_id: id,
          error: err,
        });
      } finally {
        this.disconnectClient(client.id, "stream-ended");
        // The consume loop is gone, so the connection can never be serviced
        // again — close the transport so the client sees a disconnect and
        // reconnects immediately instead of waiting out its receive timeout.
        try {
          validatedTransport.close();
        } catch {
          // ignore
        }
      }
    })();

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
   * Nack a message that failed to apply: an ack carrying `error` tells the
   * sender the message was permanently rejected (and why), so it stops
   * waiting instead of retransmitting a message that would fail again. Also
   * published over pubsub so it reaches clients homed on other nodes.
   * Send failures are swallowed — if the transport is broken, the consume
   * loop's stream error handling closes the connection.
   */
  async #nackFailedMessage(client: Client<Context>, message: Message<Context>, error: unknown) {
    const nack = new AckMessage(
      {
        type: "ack",
        messageId: message.id,
        error: error instanceof Error ? error.message : String(error),
      },
      message.context,
    );
    try {
      await client.send(nack);
      await this.pubSub.publish(`ack/${client.id}` as const, nack.encoded, `server-${client.id}`);
    } catch {
      // ignore — connection-level failures are handled by the consume loop
    }
  }

  /**
   * Disconnect a client from all sessions.
   * @param client - The client or client ID to disconnect.
   * @param reason - The reason for disconnection.
   */
  disconnectClient(client: string | Client<Context>, reason: ClientDisconnectReason = "manual") {
    const clientId = typeof client === "string" ? client : client.id;

    for (const s of this.#sessions.values()) {
      s.removeClient(client);
    }

    emitWideEvent("info", {
      event_type: "client_disconnect",
      timestamp: new Date().toISOString(),
      client_id: clientId,
      reason,
      total_sessions: this.#sessions.size,
    });

    // Record client disconnect metric
    this.#metrics.clientsActive.dec();

    this.call("client-disconnect", { clientId, reason });
  }

  /**
   * Handle cleanup of a session that was scheduled for disposal.
   */
  #handleSessionCleanup(session: Session<Context>) {
    const existingSession = this.#sessions.get(session.namespacedDocumentId);
    if (!existingSession || existingSession !== session) {
      return;
    }

    if (session.shouldDispose) {
      emitWideEvent("info", {
        event_type: "session_cleanup",
        timestamp: new Date().toISOString(),
        document_id: session.documentId,
        namespaced_document_id: session.namespacedDocumentId,
        session_id: session.id,
      });

      this.call("document-unload", {
        documentId: session.documentId,
        namespacedDocumentId: session.namespacedDocumentId,
        sessionId: session.id,
        encrypted: session.encrypted,
        reason: "cleanup",
      });

      this.#sessions.delete(session.namespacedDocumentId);
      this.#tentativeEncryptionSessions.delete(session.namespacedDocumentId);
      this.#metrics.sessionsActive.dec();

      session[Symbol.asyncDispose]().catch((error) => {
        emitWideEvent("error", {
          event_type: "session_dispose_error",
          timestamp: new Date().toISOString(),
          document_id: session.documentId,
          session_id: session.id,
          error,
        });
      });
    }
  }

  /**
   * Async dispose the server.
   */
  async [Symbol.asyncDispose](): Promise<void> {
    emitWideEvent("info", {
      event_type: "server_dispose_start",
      timestamp: new Date().toISOString(),
      node_id: this.#nodeId,
      active_sessions: this.#sessions.size,
      pending_sessions: this.#pendingSessions.size,
    });

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
        emitWideEvent("error", {
          event_type: "session_dispose_error",
          timestamp: new Date().toISOString(),
          session_id: s.id,
          document_id: s.documentId,
          error,
        });
      }
    }

    try {
      await this.pubSub[Symbol.asyncDispose]?.();
    } catch (error) {
      emitWideEvent("error", {
        event_type: "pubsub_dispose_error",
        timestamp: new Date().toISOString(),
        node_id: this.#nodeId,
        error,
      });
    }

    this.call("after-server-shutdown", {
      nodeId: this.#nodeId,
    });

    emitWideEvent("info", {
      event_type: "server_disposed",
      timestamp: new Date().toISOString(),
      node_id: this.#nodeId,
    });
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
    const totalMessagesProcessed = this.#metrics.totalMessagesProcessed.getValue();

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
