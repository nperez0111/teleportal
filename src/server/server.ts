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
  LivenessConfig,
  ServerEvents,
} from "./events";
import { getPresenceRpcHandlers, type PresenceProtocolConfig } from "../protocols/presence/server";
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
   * Configuration for the built-in presence protocol (who is in a document),
   * registered by default as RPC handlers. Pass `false` to opt out — e.g. to
   * register your own implementation via `rpcHandlers`.
   */
  presence?: PresenceProtocolConfig<NoInfer<Context>> | false;

  /**
   * Configuration for transport-level client liveness (the ping sweep that
   * kills half-open connections).
   */
  livenessConfig?: LivenessConfig;

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
   * Clients currently connected to this node, keyed by client id and holding the
   * exact {@link Client} instance registered by that physical connection.
   *
   * A connection wires up both an abort listener and a stream-ended finally,
   * either of which can call {@link disconnectClient}; membership here makes
   * disconnect idempotent so the active-client gauge and `client-disconnect`
   * event fire exactly once per client.
   *
   * Storing the instance (not just the id) is what makes reconnection with a
   * reused client id safe: when a client disconnects and immediately reconnects,
   * the OLD connection's consume-loop `finally` runs a microtask later and calls
   * `disconnectClient` for that same id — by which point the NEW connection has
   * already re-registered a different {@link Client} instance under it. Teardown
   * only proceeds when the registered instance still matches the one being torn
   * down, so a stale teardown can never evict the freshly reconnected client.
   */
  #connectedClients = new Map<string, Client<Context>>();
  /**
   * Per-connection teardown callbacks, keyed by the exact {@link Client}
   * instance a physical connection registered. Each closure closes that
   * connection's validated transport, which ends its consume loop and runs the
   * loop's `finally` (disconnect + transport close). {@link Symbol.asyncDispose}
   * uses this to actively hang up every connected client on shutdown — otherwise
   * a loopback (`serverTransport`) client's consume loop would keep awaiting its
   * still-open channel and the client would believe it is forever connected.
   * Keyed by instance (not id) so it composes with reconnect-under-same-id.
   */
  #clientTeardowns = new Map<Client<Context>, () => void>();
  /**
   * Every {@link Client} instance this server has managed via
   * {@link createClient}. Used by {@link #isClientActive} to distinguish a
   * client whose connection lifecycle the server owns (must still be the
   * registered instance to (re)join a session) from a client handed directly to
   * {@link getOrOpenSession}/{@link Session.addClient} by an embedder or test
   * harness (never tracked in {@link #connectedClients}, so it is always allowed
   * to join). A {@link WeakSet} so disconnected clients can be GC'd.
   */
  #managedClients = new WeakSet<Client<Context>>();
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
  /** Effective handler registry: default protocols (presence) + user-supplied. */
  #rpcHandlers: RpcHandlerRegistry;
  /**
   * Per-client liveness used to kill the presence of dead connections: a
   * wedged (half-open) socket never emits a close event, so without this its
   * presence entries would survive forever. `lastSeen` is refreshed by every
   * decoded inbound message and by protocol pings (via {@link markClientAlive});
   * `pingCapable` latches once the client demonstrates it heartbeats, and only
   * ping-capable clients are ever presumed dead (see
   * {@link LivenessConfig.clientTtlMs}). `close` tears down the transport so a
   * client that was wrongly presumed dead reconnects cleanly instead of
   * lingering on a connection the server no longer services.
   */
  #clientLiveness = new Map<
    string,
    { lastSeen: number; pingCapable: boolean; close: () => void }
  >();
  #clientLivenessTimer: ReturnType<typeof setInterval> | undefined;
  #lastLivenessSweepAt = 0;
  readonly #clientTtlMs: number;

  constructor(options: ServerOptions<Context>) {
    super();
    this.#options = options;

    this.pubSub = options.pubSub ?? new InMemoryPubSub();
    this.#nodeId = options.nodeId ?? `node-${uuidv4()}`;
    this.#metrics = new MetricsCollector(register);
    this.#clientTtlMs = options.livenessConfig?.clientTtlMs ?? 60_000;
    if (this.#clientTtlMs > 0) {
      this.#clientLivenessTimer = setInterval(
        () => this.sweepDeadClients(),
        Math.max(1, Math.floor(this.#clientTtlMs / 2)),
      );
      // Don't keep the process alive solely for the liveness sweep.
      (this.#clientLivenessTimer as { unref?: () => void }).unref?.();
    }

    // Presence is a default-on RPC protocol: core contains zero presence
    // logic, and swapping the implementation = `presence: false` plus your own
    // handlers (user-supplied entries win on method-name collisions).
    this.#rpcHandlers = {
      ...(options.presence === false ? {} : getPresenceRpcHandlers(options.presence ?? {})),
      ...options.rpcHandlers,
    };

    // Initialize RPC handlers
    for (const handler of Object.values(this.#rpcHandlers)) {
      if (handler.init) {
        const cleanup = handler.init(this);
        if (cleanup) {
          this.#handlerCleanups.push(cleanup);
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
   * Look up an existing session by its (composite) document ID.
   * Returns `undefined` when no session is open for the document.
   */
  getSession(documentId: string): Session<Context> | undefined {
    return this.#sessions.get(documentId);
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
        if (client && this.#isClientActive(client)) {
          existing.addClient(client);
        }
        return existing;
      }

      if (!encryptionAuthoritative) {
        // Metadata attaches to the session regardless of its mode and never
        // (re)defines it.
        if (client && this.#isClientActive(client)) {
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
          attributionConfig: this.#options.attributionConfig,
          rpcHandlers: this.#rpcHandlers,
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

    if (client && this.#isClientActive(client)) {
      session.addClient(client);
    }

    return session;
  }

  /**
   * Whether `client` is still the live connection registered under its id.
   *
   * A client's consume loop can drain a message that was already buffered in
   * the transport at the moment the client disconnected. Processing that
   * straggler calls {@link getOrOpenSession} with the client, which would
   * otherwise re-`addClient` it to the session AFTER {@link disconnectClient}
   * already removed it — resurrecting a ghost participant and preventing the
   * session from ever becoming idle-cleanup eligible. Gating every session
   * (re)join on current registration closes that teardown-vs-drain race. The
   * instance check (not just the id) also means a stale straggler cannot attach
   * itself to a session owned by a newer connection that reconnected under the
   * same id.
   */
  #isClientActive(client: Client<Context>): boolean {
    // Clients the server never managed (handed straight to getOrOpenSession by
    // an embedder or test harness) have no connection lifecycle here, so they
    // are always eligible to join a session.
    if (!this.#managedClients.has(client)) {
      return true;
    }
    // A server-managed client may only (re)join while it is still the live
    // instance registered under its id — this rejects a straggler message
    // draining after disconnect, or one belonging to a connection superseded by
    // a reconnect under the same id.
    return this.#connectedClients.get(client.id) === client;
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
          // Best-effort traffic is never NACKed — being droppable under pressure without
          // a retransmit round-trip is exactly what qos.ack: false buys.
          if (!message.requiresAck) {
            return;
          }
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

    // Track liveness from the moment the connection exists. The transport is
    // closed when the client is presumed dead so it reconnects cleanly.
    this.#clientLiveness.set(id, {
      lastSeen: Date.now(),
      pingCapable: false,
      close: () => {
        try {
          validatedTransport.close();
        } catch {
          // ignore — the transport may already be closed
        }
      },
    });

    // Consume validated transport source
    (async () => {
      try {
        await forEachMessage(validatedTransport.source, async (message) => {
          const liveness = this.#clientLiveness.get(id);
          if (liveness) {
            liveness.lastSeen = Date.now();
          }
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
              // define the session's mode; rpc flags describe only the
              // message payload and may not.
              encryptionAuthoritative: message.type !== "rpc",
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

            // Best-effort messages (awareness, rpc pushes with qos.ack: false) are never
            // acked — the sender does not track them in flight.
            if (message.requiresAck) {
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
            }

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
        // This connection's loop is over; drop its shutdown teardown (keyed by
        // instance, so this never removes a newer reconnection's entry).
        this.#clientTeardowns.delete(client);
        // Pass the client INSTANCE, not just the id: if the client already
        // reconnected under the same id, this stale teardown must be a no-op and
        // must not close the new connection's transport below.
        const tornDown = this.disconnectClient(client, "stream-ended");
        // The consume loop is gone, so this connection can never be serviced
        // again — close the transport so the client sees a disconnect and
        // reconnects immediately instead of waiting out its receive timeout.
        // Only when we actually tore THIS client down: if a newer connection has
        // superseded us, its transport must stay open.
        if (tornDown) {
          try {
            validatedTransport.close();
          } catch {
            // ignore
          }
        }
      }
    })();

    // Record client connect metric. Registering the instance (not just the id)
    // lets teardown distinguish this physical connection from a later one that
    // reconnects under the same id.
    this.#connectedClients.set(id, client);
    this.#managedClients.add(client);
    // Record how to hang up this specific connection on server shutdown. Closing
    // the validated transport ends the consume loop above, whose `finally` then
    // disconnects the client and notifies its transport.
    this.#clientTeardowns.set(client, () => {
      try {
        validatedTransport.close();
      } catch {
        // ignore — best-effort shutdown
      }
    });
    this.#metrics.clientsActive.inc();

    this.call("client-connect", { clientId: id });

    if (abortSignal) {
      abortSignal.addEventListener("abort", () => {
        this.disconnectClient(client, "abort");
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
    // Best-effort senders track nothing in flight — a NACK would go nowhere.
    if (!message.requiresAck) {
      return;
    }
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
   * Record proof of life for a client's connection: called by transports when
   * a protocol ping arrives (decoded messages refresh liveness in the consume
   * loop directly). The first ping also marks the client ping-capable, opting
   * it into dead-client sweeping — see {@link LivenessConfig.clientTtlMs}.
   */
  markClientAlive(clientId: string): void {
    const liveness = this.#clientLiveness.get(clientId);
    if (liveness) {
      liveness.lastSeen = Date.now();
      liveness.pingCapable = true;
    }
  }

  /**
   * One dead-client sweep tick (driven by the interval): disconnect every
   * ping-capable client whose last sign of life is older than
   * {@link LivenessConfig.clientTtlMs}. Disconnecting removes the client from
   * all sessions, which broadcasts presence-leave for its awareness entries —
   * so peers stop seeing ghosts of dead connections. Public so it can be
   * driven deterministically in tests.
   */
  sweepDeadClients(): void {
    if (this.#clientTtlMs <= 0) {
      return;
    }
    const now = Date.now();

    // Stall guard: the sweep runs every ttl/2, so arriving a full TTL late
    // means THIS process stalled (event-loop freeze, suspend, clock jump) —
    // the silence is ours, not the clients'. Every lastSeen is uniformly
    // stale, and sweeping now would mass-disconnect all ping-capable clients
    // at once, a self-inflicted reconnect storm exactly when the server is
    // already struggling. Grant a fresh window instead.
    if (this.#lastLivenessSweepAt !== 0 && now - this.#lastLivenessSweepAt > this.#clientTtlMs) {
      emitWideEvent("info", {
        event_type: "client_liveness_sweep_stalled",
        timestamp: new Date().toISOString(),
        sweep_delay_ms: now - this.#lastLivenessSweepAt,
        client_ttl_ms: this.#clientTtlMs,
      });
      for (const liveness of this.#clientLiveness.values()) {
        liveness.lastSeen = now;
      }
      this.#lastLivenessSweepAt = now;
      return;
    }
    this.#lastLivenessSweepAt = now;

    for (const [clientId, liveness] of this.#clientLiveness) {
      if (!liveness.pingCapable || now - liveness.lastSeen <= this.#clientTtlMs) {
        continue;
      }
      emitWideEvent("info", {
        event_type: "client_presumed_dead",
        timestamp: new Date().toISOString(),
        client_id: clientId,
        last_seen_ms_ago: now - liveness.lastSeen,
        client_ttl_ms: this.#clientTtlMs,
      });
      // disconnectClient deletes the liveness entry; closing the transport
      // afterwards ends the consume loop (whose stream-ended path re-invoking
      // disconnectClient is a no-op thanks to idempotency).
      this.disconnectClient(clientId, "timeout");
      liveness.close();
    }
  }

  /**
   * Disconnect a client from all sessions.
   *
   * @param client - The client instance or client ID to disconnect. Prefer the
   *   instance: passing an id tears down whichever client is currently
   *   registered under it, whereas passing the instance only tears down that
   *   exact connection. The latter is required for reconnect safety — a stale
   *   connection's deferred teardown passes its own {@link Client} object, which
   *   no longer matches the instance a newer reconnection registered under the
   *   same id, so it correctly becomes a no-op instead of evicting the new one.
   * @param reason - The reason for disconnection.
   * @returns `true` if this call actually disconnected the client, `false` if it
   *   was a no-op (already disconnected, or superseded by a newer connection).
   */
  disconnectClient(
    client: string | Client<Context>,
    reason: ClientDisconnectReason = "manual",
  ): boolean {
    const clientId = typeof client === "string" ? client : client.id;
    const registered = this.#connectedClients.get(clientId);

    // Idempotent: a client that was never connected here, or was already
    // disconnected, must not remove sessions, decrement the gauge, or re-emit
    // the event. Both the abort listener and the stream-ended finally target
    // the same client; only the first call does work. The liveness delete
    // must sit BEHIND this guard: on an id-reusing transport, a stale
    // connection's redundant disconnect would otherwise delete the liveness
    // entry a reconnect just registered.
    if (!registered) {
      return false;
    }

    // Instance mismatch: the id was re-registered by a NEWER connection since
    // this (stale) teardown was scheduled. Leave the new client untouched.
    if (typeof client !== "string" && registered !== client) {
      return false;
    }

    this.#clientLiveness.delete(clientId);
    this.#connectedClients.delete(clientId);

    // Remove the exact registered instance from every session. Using `registered`
    // rather than `client` matters when a bare id was passed: it guarantees we
    // remove the client the server actually knows about.
    for (const s of this.#sessions.values()) {
      s.removeClient(registered);
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
    return true;
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

    if (this.#clientLivenessTimer !== undefined) {
      clearInterval(this.#clientLivenessTimer);
      this.#clientLivenessTimer = undefined;
    }
    this.#clientLiveness.clear();

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

    // Actively hang up every connected client. Without this, a loopback
    // (`serverTransport`) client's consume loop would keep awaiting its still-open
    // channel and the client would believe it is connected forever. Closing each
    // validated transport ends its consume loop, whose `finally` disconnects the
    // client and notifies the transport (which surfaces as a disconnect on the
    // client connection). Snapshot first: the teardowns mutate the map.
    const teardowns = Array.from(this.#clientTeardowns.values());
    this.#clientTeardowns.clear();
    for (const teardown of teardowns) {
      teardown();
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
    // Count distinct clients connected to this node. A single client may be
    // joined to several sessions; the connected-id registry counts it once,
    // whereas summing per-session client counts would double-count it.
    const activeClients = this.#connectedClients.size;

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
