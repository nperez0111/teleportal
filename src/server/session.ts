import {
  decodeMessage,
  type DecodedPresenceHeartbeat,
  type DecodedPresenceJoin,
  type DecodedPresenceLeave,
  DocMessage,
  type Message,
  PresenceMessage,
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
import type { DocumentStorage, EncryptedDocumentStorage } from "teleportal/storage";
import type { EncodedContentMap } from "teleportal/storage";
import type { EncryptedUpdatePayload } from "teleportal/protocol/encryption";
import { decodeEncryptedUpdate } from "teleportal/protocol/encryption";
import {
  type ContentIds,
  createContentAttribute,
  createContentIdsFromUpdate,
  createContentMapFromContentIds,
  decodeContentIds,
  encodeContentMap,
  mergeContentIds,
} from "teleportal/attribution";
import { Observable } from "../lib/utils";
import { Client } from "./client";
import { TtlDedupe } from "./dedupe";
import type { DocumentMessageSource, PresenceConfig, SessionEvents } from "./events";
import { emitWideEvent } from "./logger";
import type { Server } from "./server";

export class Session<Context extends ServerContext> extends Observable<SessionEvents<Context>> {
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
  #documentSizeConfig: { warningThreshold?: number; limit?: number } | undefined;
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
  #presenceConfig: PresenceConfig<Context> | undefined;
  /**
   * The presence of each connected (local) client, keyed by session client id.
   * Records the numeric awareness clientID a client announced (cleartext, so it
   * works for encrypted documents), its server context, and the resolved
   * presence `data` (computed once at announce), so the session can tell peers
   * which awareness state to clear when the client leaves and can advertise the
   * client in heartbeats without re-running `getPresenceData`.
   */
  #clientPresence = new Map<
    string,
    { awarenessId: number; context: Context; data: Record<string, unknown> }
  >();
  /**
   * Presence of clients connected to *other* nodes, keyed by node id, then by
   * client id. Built from pub/sub presence join/leave and heartbeat snapshots,
   * so a newcomer learns about cross-node peers. Each node carries a `lastSeen`
   * timestamp; a node whose heartbeats stop is TTL-expired and its clients are
   * cleared from local peers (self-healing across node crashes).
   */
  #remotePresence = new Map<
    string,
    {
      lastSeen: number;
      clients: Map<string, { awarenessId: number; userId: string; data: Record<string, unknown> }>;
    }
  >();
  #heartbeatIntervalMs: number;
  #presenceTtlMs: number;
  #presenceTimerId: ReturnType<typeof setInterval> | undefined;

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
    presenceConfig?: PresenceConfig<Context>;
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
    this.#presenceConfig = args.presenceConfig;
    this.#heartbeatIntervalMs = args.presenceConfig?.heartbeatIntervalMs ?? 30_000;
    this.#presenceTtlMs = args.presenceConfig?.presenceTtlMs ?? 90_000;
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
                return this.#rpcHandlers[ctx.method]?.[ctx.requestType]?.decode(ctx.payload);
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
            // Presence messages skip dedup: heartbeats are periodic and
            // content-hashed, so identical snapshots would collide inside the
            // dedup TTL window and be dropped. Presence handlers are idempotent
            // (join upserts, leave removes, heartbeat replaces), so re-applying
            // is safe.
            if (message.type !== "presence") {
              const shouldAccept = this.#dedupe.shouldAccept(this.namespacedDocumentId, message.id);

              if (!shouldAccept) {
                this.#emitDocumentMessage(message, undefined, "replication", sourceId, true);
                return;
              }
            }

            await this.apply(message, undefined, {
              sourceNodeId: sourceId,
              deduped: false,
            });
          } catch (error_) {
            emitWideEvent("error", {
              event_type: "replication_apply_failed",
              timestamp: new Date().toISOString(),
              document_id: this.documentId,
              session_id: this.id,
              message_id: message.id,
              source_node_id: sourceId,
              error: {
                type: error_ instanceof Error ? error_.name : "Error",
                message: error_ instanceof Error ? error_.message : String(error_),
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

    this.#startPresenceMaintenance();
  }

  /**
   * Periodically (a) advertise this node's local clients to other nodes and
   * (b) expire remote nodes that have gone silent. Idempotent.
   */
  #startPresenceMaintenance() {
    if (this.#presenceTimerId !== undefined || this.#heartbeatIntervalMs <= 0) {
      return;
    }
    this.#presenceTimerId = setInterval(() => {
      void this.runPresenceMaintenance();
    }, this.#heartbeatIntervalMs);
    // Don't keep the process alive solely for presence heartbeats.
    (this.#presenceTimerId as { unref?: () => void }).unref?.();
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
      this.#broadcastClientLeave(id);

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
   * Resolve the integrator-configured presence `data` for a client context,
   * tolerating a throwing or rejecting projection.
   */
  async #getPresenceData(context: Context): Promise<Record<string, unknown>> {
    if (!this.#presenceConfig?.getPresenceData) {
      return {};
    }
    try {
      return await this.#presenceConfig.getPresenceData(context);
    } catch (error) {
      emitWideEvent("error", {
        event_type: "presence_data_failed",
        timestamp: new Date().toISOString(),
        document_id: this.documentId,
        session_id: this.id,
        client_id: context.clientId,
        error,
      });
      return {};
    }
  }

  /**
   * Record a client's announced awareness clientID and tell peers it joined.
   *
   * The announce is the only cleartext channel carrying the numeric awareness
   * clientID, so this is what makes presence (and awareness clearing) work for
   * end-to-end encrypted documents. The announcing client is also sent the
   * current same-node roster so it learns existing peers' presence data.
   */
  async #handlePresenceAnnounce(
    client: { id: string; send: (m: Message<Context>) => Promise<void> },
    awarenessId: number,
    context: Context,
  ) {
    // Resolve the presence data once and cache it, so heartbeats and the leave
    // broadcast don't re-run the (possibly async/DB-backed) projection.
    const data = await this.#getPresenceData(context);
    this.#clientPresence.set(client.id, { awarenessId, context, data });

    // Tell the newcomer about everyone already present (same node)...
    for (const [otherId, other] of this.#clientPresence) {
      if (otherId === client.id) {
        continue;
      }
      const message = new PresenceMessage<Context>(this.documentId, {
        type: "presence-join",
        awarenessId: other.awarenessId,
        clientId: otherId,
        userId: other.context.userId,
        data: other.data,
      });
      await client.send(message).catch(() => {});
    }

    // ...and about peers on other nodes (learned via pub/sub join/heartbeat).
    for (const node of this.#remotePresence.values()) {
      for (const [otherId, other] of node.clients) {
        const message = new PresenceMessage<Context>(this.documentId, {
          type: "presence-join",
          awarenessId: other.awarenessId,
          clientId: otherId,
          userId: other.userId,
          data: other.data,
        });
        await client.send(message).catch(() => {});
      }
    }

    // Tell already-announced peers that the newcomer joined. Peers that have
    // not announced yet are skipped — they will receive the newcomer in their
    // own roster when they announce, which avoids a duplicate join. Other nodes
    // get the join via pub/sub.
    const joinMessage = new PresenceMessage<Context>(this.documentId, {
      type: "presence-join",
      awarenessId,
      clientId: client.id,
      userId: context.userId,
      data,
    });
    const sends: Promise<unknown>[] = [];
    for (const otherId of this.#clientPresence.keys()) {
      if (otherId === client.id) {
        continue;
      }
      const peer = this.#clients.get(otherId);
      if (peer) {
        sends.push(peer.send(joinMessage));
      }
    }
    sends.push(
      this.#pubSub.publish(
        `document/${this.namespacedDocumentId}` as const,
        joinMessage.encoded,
        this.#nodeId,
      ),
    );
    await Promise.all(sends).catch((error) => {
      emitWideEvent("error", {
        event_type: "presence_join_broadcast_failed",
        timestamp: new Date().toISOString(),
        document_id: this.documentId,
        session_id: this.id,
        client_id: client.id,
        error,
      });
    });
  }

  /**
   * Tell peers a client left so they clear its awareness locally. Works for
   * encrypted documents because the awareness clientID travels in cleartext.
   */
  #broadcastClientLeave(clientId: string) {
    const presence = this.#clientPresence.get(clientId);
    this.#clientPresence.delete(clientId);
    if (!presence) {
      return;
    }
    const message = new PresenceMessage<Context>(this.documentId, {
      type: "presence-leave",
      awarenessId: presence.awarenessId,
      clientId,
      userId: presence.context.userId,
      data: presence.data,
    });
    void Promise.all([
      this.broadcast(message, clientId),
      this.#pubSub.publish(
        `document/${this.namespacedDocumentId}` as const,
        message.encoded,
        this.#nodeId,
      ),
    ]).catch((error) => {
      emitWideEvent("error", {
        event_type: "presence_leave_broadcast_failed",
        timestamp: new Date().toISOString(),
        document_id: this.documentId,
        session_id: this.id,
        client_id: clientId,
        error,
      });
    });
  }

  /**
   * Locally fan out a server-authored presence-join/leave (clearing the peer's
   * awareness on leave is done client-side from this message).
   */
  #broadcastPresence(payload: DecodedPresenceJoin | DecodedPresenceLeave): Promise<void> {
    return this.broadcast(new PresenceMessage<Context>(this.documentId, payload));
  }

  /**
   * Record/refresh a single remote client (from a pub/sub presence-join), so the
   * cross-node roster stays current between heartbeats.
   */
  #upsertRemoteClient(nodeId: string, payload: DecodedPresenceJoin) {
    const node = this.#remotePresence.get(nodeId) ?? {
      lastSeen: Date.now(),
      clients: new Map<
        string,
        { awarenessId: number; userId: string; data: Record<string, unknown> }
      >(),
    };
    node.lastSeen = Date.now();
    node.clients.set(payload.clientId, {
      awarenessId: payload.awarenessId,
      userId: payload.userId,
      data: payload.data,
    });
    this.#remotePresence.set(nodeId, node);
  }

  /**
   * Forget a single remote client (from a pub/sub presence-leave).
   */
  #removeRemoteClient(nodeId: string, clientId: string) {
    const node = this.#remotePresence.get(nodeId);
    if (!node) {
      return;
    }
    node.lastSeen = Date.now();
    node.clients.delete(clientId);
    if (node.clients.size === 0) {
      this.#remotePresence.delete(nodeId);
    }
  }

  /**
   * Reconcile a node's full roster snapshot (from a pub/sub presence-heartbeat)
   * against what we last knew for it: fan out joins for newly-seen clients,
   * leaves for clients that disappeared, then store the snapshot and refresh the
   * node's liveness. Self-heals any join/leave message that was lost.
   */
  async #reconcileRemoteSnapshot(nodeId: string, clients: DecodedPresenceHeartbeat["clients"]) {
    const previous = this.#remotePresence.get(nodeId)?.clients ?? new Map();
    const next = new Map<
      string,
      { awarenessId: number; userId: string; data: Record<string, unknown> }
    >();
    const sends: Promise<void>[] = [];

    for (const peer of clients) {
      next.set(peer.clientId, {
        awarenessId: peer.awarenessId,
        userId: peer.userId,
        data: peer.data,
      });
      if (!previous.has(peer.clientId)) {
        sends.push(
          this.#broadcastPresence({
            type: "presence-join",
            awarenessId: peer.awarenessId,
            clientId: peer.clientId,
            userId: peer.userId,
            data: peer.data,
          }),
        );
      }
    }

    for (const [clientId, peer] of previous) {
      if (!next.has(clientId)) {
        sends.push(
          this.#broadcastPresence({
            type: "presence-leave",
            awarenessId: peer.awarenessId,
            clientId,
            userId: peer.userId,
            data: peer.data,
          }),
        );
      }
    }

    this.#remotePresence.set(nodeId, { lastSeen: Date.now(), clients: next });
    await Promise.all(sends);
  }

  /**
   * Build a heartbeat snapshot of this node's local clients.
   */
  #localPresenceSnapshot(): DecodedPresenceHeartbeat["clients"] {
    return [...this.#clientPresence.entries()].map(([clientId, presence]) => ({
      awarenessId: presence.awarenessId,
      clientId,
      userId: presence.context.userId,
      data: presence.data,
    }));
  }

  /**
   * One presence-maintenance tick (driven by the interval): advertise this
   * node's local clients to other nodes, then expire any remote node that has
   * stopped sending heartbeats (e.g. crashed) and clear its clients locally.
   * Public so it can be driven deterministically in tests.
   */
  async runPresenceMaintenance() {
    const sends: Promise<unknown>[] = [];

    if (this.#clientPresence.size > 0) {
      const heartbeat = new PresenceMessage<Context>(this.documentId, {
        type: "presence-heartbeat",
        clients: this.#localPresenceSnapshot(),
      });
      sends.push(
        this.#pubSub.publish(
          `document/${this.namespacedDocumentId}` as const,
          heartbeat.encoded,
          this.#nodeId,
        ),
      );
    }

    const now = Date.now();
    for (const [nodeId, node] of this.#remotePresence) {
      if (now - node.lastSeen <= this.#presenceTtlMs) {
        continue;
      }
      this.#remotePresence.delete(nodeId);
      for (const [clientId, peer] of node.clients) {
        sends.push(
          this.#broadcastPresence({
            type: "presence-leave",
            awarenessId: peer.awarenessId,
            clientId,
            userId: peer.userId,
            data: peer.data,
          }),
        );
      }
    }

    await Promise.all(sends).catch((error) => {
      emitWideEvent("error", {
        event_type: "presence_maintenance_failed",
        timestamp: new Date().toISOString(),
        document_id: this.documentId,
        session_id: this.id,
        error,
      });
    });
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
  async write(update: Update, context?: Context, source: DocumentMessageSource = "client") {
    try {
      let attribution: EncodedContentMap | undefined;
      if (source === "client" && context?.userId) {
        try {
          attribution = this.#computeAttribution(update, context);
        } catch (error) {
          emitWideEvent("error", {
            event_type: "attribution_compute_failed",
            timestamp: new Date().toISOString(),
            document_id: this.documentId,
            session_id: this.id,
            error,
          });
        }
      }

      await this.#storage.handleUpdate(this.namespacedDocumentId, update, attribution);

      if (attribution) {
        this.call("document-attribution", {
          documentId: this.documentId,
          namespacedDocumentId: this.namespacedDocumentId,
          sessionId: this.id,
          userId: context!.userId,
          timestamp: Date.now(),
          contentMap: attribution,
        });
      }

      this.call("document-write", {
        documentId: this.documentId,
        namespacedDocumentId: this.namespacedDocumentId,
        sessionId: this.id,
        encrypted: this.encrypted,
        context,
      });
      void this.#updateDocumentSizeMetrics(context);
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

  #computeAttribution(update: Update, context: Context) {
    let contentIds: ContentIds;
    if (this.encrypted) {
      const message = decodeEncryptedUpdate(update as unknown as EncryptedUpdatePayload);
      if (message.type !== "update") {
        contentIds = createContentIdsFromUpdate(update);
      } else {
        const decoded = message.updates.map((m) => decodeContentIds(m.contentIds));
        contentIds = decoded.length === 1 ? decoded[0] : mergeContentIds(decoded);
      }
    } else {
      contentIds = createContentIdsFromUpdate(update);
    }
    const now = Date.now();
    const userId = context.userId;
    return encodeContentMap(
      createContentMapFromContentIds(
        contentIds,
        [createContentAttribute("insert", userId), createContentAttribute("insertAt", now)],
        [createContentAttribute("delete", userId), createContentAttribute("deleteAt", now)],
      ),
    );
  }

  async #updateDocumentSizeMetrics(context?: Context) {
    const meta = await this.#storage.getDocumentMetadata(this.namespacedDocumentId);

    const sizeBytes = meta.sizeBytes ?? 0;
    const warningThreshold =
      meta.sizeWarningThreshold ?? this.#documentSizeConfig?.warningThreshold;
    const sizeLimit = meta.sizeLimit ?? this.#documentSizeConfig?.limit;

    this.#metrics?.recordDocumentSize(this.namespacedDocumentId, sizeBytes, this.encrypted);

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
    // Presence messages are always cleartext metadata (they carry no document
    // content), so they are exempt from the document's encryption requirement.
    if (message.type !== "presence" && message.encrypted !== this.encrypted) {
      const error = new Error("Message encryption and document encryption are mismatched");
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
              const messageSource: DocumentMessageSource = replicationMeta?.sourceNodeId
                ? "replication"
                : "client";

              const encryptedStorage =
                this.encrypted &&
                typeof (this.#storage as EncryptedDocumentStorage).handleEncryptedUpdate ===
                  "function"
                  ? (this.#storage as EncryptedDocumentStorage)
                  : null;

              if (encryptedStorage) {
                const storedUpdate = await encryptedStorage.handleEncryptedUpdate(
                  this.namespacedDocumentId,
                  message.payload.update,
                );
                if (!storedUpdate) {
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
                    messageSource,
                    replicationMeta?.sourceNodeId,
                    replicationMeta?.deduped,
                  );
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
                  this.broadcast(broadcastMessage, client?.id),
                  this.#pubSub.publish(
                    `document/${this.namespacedDocumentId}` as const,
                    broadcastMessage.encoded,
                    this.#nodeId,
                  ),
                ]);

                void this.#updateDocumentSizeMetrics(message.context);

                this.#emitDocumentMessage(
                  broadcastMessage,
                  client,
                  messageSource,
                  replicationMeta?.sourceNodeId,
                  replicationMeta?.deduped,
                );

                return;
              }

              await this.write(message.payload.update, message.context, messageSource);

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
                messageSource,
                replicationMeta?.sourceNodeId,
                replicationMeta?.deduped,
              );

              return;
            }
            case "sync-step-2": {
              const encryptedStorage =
                this.encrypted &&
                typeof (this.#storage as EncryptedDocumentStorage).handleEncryptedSyncStep2 ===
                  "function"
                  ? (this.#storage as EncryptedDocumentStorage)
                  : null;

              if (encryptedStorage) {
                const payloads = await encryptedStorage.handleEncryptedSyncStep2(
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
                        this.broadcast(broadcastMessage, client?.id),
                        this.#pubSub.publish(
                          `document/${this.namespacedDocumentId}` as const,
                          broadcastMessage.encoded,
                          this.#nodeId,
                        ),
                      ]);

                      this.#emitDocumentMessage(
                        broadcastMessage,
                        client,
                        replicationMeta?.sourceNodeId ? "replication" : "client",
                        replicationMeta?.sourceNodeId,
                        replicationMeta?.deduped,
                      );
                    }),
                  );
                }

                void this.#updateDocumentSizeMetrics(message.context);

                if (!client) {
                  emitWideEvent("info", {
                    event_type: "sync_step2_no_client",
                    timestamp: new Date().toISOString(),
                    message_id: message.id,
                    document_id: this.documentId,
                    namespaced_document_id: this.namespacedDocumentId,
                  });
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

              await Promise.all([
                this.broadcast(message, client?.id),
                this.#storage.handleSyncStep2(this.namespacedDocumentId, message.payload.update),
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
                unknown_payload_type: (message.payload as { type?: string }).type,
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

          switch (requestType) {
            case "request": {
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
                const result = (await handler.handler(requestPayload, enrichedContext)) as {
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
                        statusCode: (result.response as RpcError).statusCode ?? 500,
                        details: (result.response as RpcError).details ?? "Unknown error",
                        payload: (result.response as RpcError).payload,
                      }
                    : {
                        type: "success",
                        payload: result.response,
                      };
                const serializer = (ctx: any) => {
                  if (
                    ctx.type === "rpc" &&
                    ctx.requestType === "response" && // Only serialize if it's a success response (not an error)
                    ctx.message.payload.type === "success"
                  ) {
                    return handler.response?.encode?.(result.response);
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
                    details: error instanceof Error ? error.message : "Internal error",
                  },
                  method,
                  "response",
                  rpcMessage.id,
                  rpcMessage.context,
                  rpcMessage.encrypted,
                );
                await client.send(errorMessage);
              }

              break;
            }
            case "stream": {
              const method = rpcMessage.rpcMethod;
              const handler = this.#rpcHandlers[method];

              if (handler?.streamHandler && rpcMessage.payload.type === "success") {
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
                        details: error instanceof Error ? error.message : "Stream processing error",
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

              break;
            }
            case "response": {
              break;
            }
            // No default
          }

          return;
        }
        case "presence": {
          if (message.payload.type === "presence-announce") {
            // A client announcing its awareness clientID (cleartext). Record it
            // and notify peers; never relay the announce itself.
            if (client) {
              await this.#handlePresenceAnnounce(
                client,
                message.payload.awarenessId,
                message.context,
              );
            }
            return;
          }

          // presence-join / presence-leave / presence-heartbeat are
          // server-authored. They only reach apply via pub/sub replication from
          // another node (client undefined). Update our cross-node roster for
          // that node and fan join/leave out to this node's clients.
          if (client) {
            return;
          }
          const sourceNodeId = replicationMeta?.sourceNodeId;
          if (message.payload.type === "presence-heartbeat") {
            if (sourceNodeId) {
              await this.#reconcileRemoteSnapshot(sourceNodeId, message.payload.clients);
            }
            return;
          }
          if (sourceNodeId) {
            if (message.payload.type === "presence-join") {
              this.#upsertRemoteClient(sourceNodeId, message.payload);
            } else {
              this.#removeRemoteClient(sourceNodeId, message.payload.clientId);
            }
          }
          await this.broadcast(message);
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
    this.#stopPresenceMaintenance();

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

    this.#clientPresence.clear();
    this.#remotePresence.clear();

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

  #stopPresenceMaintenance() {
    if (this.#presenceTimerId !== undefined) {
      clearInterval(this.#presenceTimerId);
      this.#presenceTimerId = undefined;
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
