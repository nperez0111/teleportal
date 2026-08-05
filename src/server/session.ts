import {
  decodeMessage,
  DocMessage,
  getEmptyStateVector,
  type Message,
  type PubSub,
  type ServerContext,
  type SyncStep2UpdateV2,
  type VersionedSyncStep2Update,
  type VersionedUpdate,
} from "teleportal";
import type { MetricsCollector } from "teleportal/monitoring";
import {
  RpcMessage,
  type RpcError,
  type RpcHandlerRegistry,
  type RpcMethodQos,
  type RpcServerContext,
  type RpcSuccess,
} from "teleportal/protocol";
import type { DocumentStorage } from "teleportal/storage";
import type { EncodedContentMap } from "teleportal/storage";
import type { EncryptedUpdatePayload } from "teleportal/protocol/encryption";
import { decodeContentEncryptedPayload } from "teleportal/protocol/encryption";
import {
  ContentAttribute,
  createContentAttribute,
  createContentIdsFromUpdate,
  createContentMapFromContentIds,
  encodeContentMap,
  recordToAttrs,
} from "teleportal/attribution";
import { attributionProtocol } from "../protocols/attribution/methods";
import { Observable } from "../lib/utils";
import { Client } from "./client";
import { TtlDedupe } from "./dedupe";
import type { AttributionConfig, DocumentMessageSource, SessionEvents } from "./events";
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
  #resyncInFlight = false;
  #resyncPending = false;
  #publishFailedSinceHeal = false;
  #cleanupTimeoutId: ReturnType<typeof setTimeout> | undefined;
  #onCleanupScheduled: (session: Session<Context>) => void;
  readonly #cleanupDelayMs: number;
  #rpcHandlers: RpcHandlerRegistry;
  #server: Server<Context>;
  #attributionConfig: AttributionConfig<Context> | undefined;

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
    attributionConfig?: AttributionConfig<Context>;
    rpcHandlers?: RpcHandlerRegistry;
    server: Server<Context>;
    /**
     * How long to wait after the last client leaves before signalling that the
     * session may be disposed. The delay lets clients reconnect without losing
     * session state. Defaults to 60s. Primarily overridden in tests to exercise
     * the cleanup-fires path deterministically.
     */
    cleanupDelayMs?: number;
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
    this.#attributionConfig = args.attributionConfig;
    this.#rpcHandlers = args.rpcHandlers ?? {};
    this.#server = args.server;
    this.#dedupe = args.dedupe ?? new TtlDedupe();
    this.#onCleanupScheduled = args.onCleanupScheduled;
    this.#cleanupDelayMs = args.cleanupDelayMs ?? 60_000;
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
            // Push methods declaring `qos.dedupe: false` skip dedup: periodic snapshots
            // (e.g. the presence roster) are content-hashed, so identical payloads would
            // collide inside the dedup TTL window and be dropped. Their handlers are
            // idempotent (upsert/remove/replace), so re-applying is safe.
            const skipDedupe =
              message.type === "rpc" &&
              this.#rpcHandlers[(message as RpcMessage<Context>).rpcMethod]?.qos?.dedupe === false;
            if (!skipDedupe) {
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
        { onGap: () => this.#handleReplicationGap() },
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
   * Resolve the delivery QoS for an RPC method from the handler registry. Methods defined via
   * `definePush` carry their declared QoS; unregistered methods get push defaults (ephemeral,
   * replicated, acked, deduped).
   */
  #resolveRpcQos(method: string, override?: Partial<RpcMethodQos>): RpcMethodQos {
    return {
      durability: "ephemeral",
      replicate: true,
      ack: true,
      dedupe: true,
      ...this.#rpcHandlers[method]?.qos,
      ...override,
    };
  }

  /**
   * Build a server-authored RPC push: an unsolicited notification shaped as a response to no
   * request (`requestType: "response"`, `originalRequestId: undefined`), stamped with the
   * method's QoS. Pushes default to cleartext — they typically carry routing/roster metadata
   * the server must read; pass `encrypted: true` only for opaque payloads.
   */
  #buildRpcPush(
    method: string,
    payload: unknown,
    opts?: { encrypted?: boolean; qos?: Partial<RpcMethodQos> },
  ): { message: RpcMessage<Context>; qos: RpcMethodQos } {
    const qos = this.#resolveRpcQos(method, opts?.qos);
    const handler = this.#rpcHandlers[method];
    const serializer = handler?.response?.encode
      ? (ctx: { type: string }) =>
          ctx.type === "rpc" ? handler.response!.encode(payload as any) : undefined
      : undefined;
    const message = new RpcMessage<Context>(
      this.documentId,
      { type: "success", payload } as RpcSuccess,
      method,
      "response",
      undefined,
      {} as Context,
      opts?.encrypted ?? false,
      undefined,
      serializer,
      { durability: qos.durability, ack: qos.ack },
    );
    return { message, qos };
  }

  /**
   * Send a server-authored RPC push to a single local client.
   */
  async sendRpcToClient(
    clientOrId: string | { id: string; send: (m: Message<Context>) => Promise<void> },
    method: string,
    payload: unknown,
    opts?: { encrypted?: boolean; qos?: Partial<RpcMethodQos> },
  ): Promise<void> {
    const client = typeof clientOrId === "string" ? this.#clients.get(clientOrId) : clientOrId;
    if (!client) {
      return;
    }
    const { message } = this.#buildRpcPush(method, payload, opts);
    await client.send(message);
  }

  /**
   * Push a server-authored RPC notification to all local clients (optionally excluding one)
   * and, when the method's QoS says `replicate`, publish it to the document topic so other
   * nodes' sessions receive it too (dispatched to the method's `pushHandler` there).
   */
  async broadcastRpc(
    method: string,
    payload: unknown,
    opts?: { excludeClientId?: string; encrypted?: boolean; qos?: Partial<RpcMethodQos> },
  ): Promise<void> {
    const { message, qos } = this.#buildRpcPush(method, payload, opts);
    await this.broadcast(message, opts?.excludeClientId);
    if (qos.replicate) {
      await this.#publishRpcMessage(message);
    }
  }

  /**
   * Publish a server-authored RPC push to other nodes only — no local broadcast. For
   * node-to-node state exchange (e.g. periodic snapshots) whose local effect is produced by
   * the protocol itself rather than by relaying the raw push.
   */
  async publishRpc(
    method: string,
    payload: unknown,
    opts?: { encrypted?: boolean; qos?: Partial<RpcMethodQos> },
  ): Promise<void> {
    const { message } = this.#buildRpcPush(method, payload, opts);
    await this.#publishRpcMessage(message);
  }

  /**
   * Dispatch an RPC push. If the method registered a `pushHandler`, it runs first and may
   * suppress the default relay. Otherwise the push is relayed to local clients as-is — the
   * behavior unregistered notifications always had via `broadcast`. Pushes authored by a local
   * client are additionally published to other nodes per the method's QoS; replicated pushes
   * are never re-published (the pub/sub fan-out already reached every node once).
   */
  async #handleRpcPush(
    rpcMessage: RpcMessage<Context>,
    client: { id: string; send: (m: Message<Context>) => Promise<void> } | undefined,
    sourceNodeId: string | undefined,
  ): Promise<void> {
    if (rpcMessage.payload.type !== "success") {
      return;
    }

    const handler = this.#rpcHandlers[rpcMessage.rpcMethod];
    let forwardToLocalClients = true;
    // Replication is a trusted node-to-node plane: receiving nodes apply
    // replicated pushes as server-authored. A client-authored push therefore
    // never enters it by default — only a registered pushHandler that has
    // inspected the payload may vouch for it with `replicate: true`. (Without
    // this, a node missing a protocol's handlers would launder forged client
    // pushes into trusted messages on every other node.)
    let replicate = false;

    if (handler?.pushHandler) {
      try {
        const result = await handler.pushHandler(rpcMessage.payload.payload, {
          server: this.#server as any,
          documentId: this.namespacedDocumentId,
          session: this as any,
          sourceNodeId,
          clientId: client?.id,
        });
        if (result?.forwardToLocalClients === false) {
          forwardToLocalClients = false;
        }
        if (result?.replicate === true) {
          replicate = true;
        }
      } catch (error) {
        emitWideEvent("error", {
          event_type: "rpc_push_handler_failed",
          timestamp: new Date().toISOString(),
          document_id: this.documentId,
          session_id: this.id,
          message_id: rpcMessage.id,
          method: rpcMessage.rpcMethod,
          error,
        });
        return;
      }
    }

    if (forwardToLocalClients) {
      await this.broadcast(rpcMessage, client?.id);
    }

    if (client && replicate) {
      // Durability does not travel the wire, so a decoded client push has none of
      // its own — re-derive it from the method definition. Without this the push
      // would fall back to the `RpcMessage` default (`durable`) and a method
      // declared ephemeral (a periodic roster, say) would be persisted in the
      // durable log and replayed to reconnecting nodes as stale state.
      await this.#publishRpcMessage(
        rpcMessage,
        this.#resolveRpcQos(rpcMessage.rpcMethod).durability,
      );
    }
  }

  #publishRpcMessage(
    message: RpcMessage<Context>,
    durability?: "durable" | "ephemeral",
  ): Promise<void> {
    return this.#publishDocumentMessage(message, durability).catch((error) => {
      emitWideEvent("error", {
        event_type: "rpc_push_publish_failed",
        timestamp: new Date().toISOString(),
        document_id: this.documentId,
        session_id: this.id,
        message_id: message.id,
        method: message.rpcMethod,
        error,
      });
    });
  }

  /**
   * Publish a message to this document's cross-node fan-out topic.
   *
   * Every document-topic publish goes through here so the message-declared durability
   * classification is applied uniformly: ephemeral types (presence/awareness/sync handshake)
   * are routed over the backend's non-durable channel so they don't consume durable-log
   * retention, while durable types (update/sync-step-2) are persisted for cross-node
   * replay/catch-up. Callers keep their own error handling around the returned promise.
   *
   * `durabilityOverride` exists for messages whose own classification is not trustworthy:
   * a message decoded off the wire carries no durability (it is not encoded), so a relayed
   * client push must have it re-derived from the method definition by the caller.
   */
  #publishDocumentMessage(
    message: Message<Context>,
    durabilityOverride?: "durable" | "ephemeral",
  ): Promise<void> {
    const durability = durabilityOverride ?? message.durability;
    const published = this.#pubSub.publish(
      `document/${this.namespacedDocumentId}` as const,
      message.encoded,
      this.#nodeId,
      { ephemeral: durability === "ephemeral" },
    );
    if (durability === "durable") {
      // A durable publish that fails means remote nodes never saw this update (their side shows
      // no gap). Remember it so the next resync also republishes full state to them. NOTE: this
      // is flushed on the next resync (i.e. the next inbound gap on this node). If this node's
      // document then goes completely quiet, the outbound republish is deferred until some later
      // resync — ioredis's offline queue already covers most short blips, so this is the
      // residual case; a durable log on the remote side is the stronger guarantee.
      published.catch(() => {
        this.#publishFailedSinceHeal = true;
      });
    }
    return published;
  }

  /**
   * Handle a durable-backend gap signal: the node may have missed cross-node updates it can no
   * longer replay. Emit observability, then heal local clients from storage.
   */
  #handleReplicationGap(): void {
    emitWideEvent("info", {
      event_type: "replication_gap",
      timestamp: new Date().toISOString(),
      document_id: this.documentId,
      session_id: this.id,
    });
    void this.call("replication-gap", {
      documentId: this.documentId,
      namespacedDocumentId: this.namespacedDocumentId,
      sessionId: this.id,
    });
    void this.resyncLocalClientsFromStorage();
  }

  /**
   * Re-derive full document state from storage and push it to local clients as an unsolicited
   * sync-step-2. This heals clients on this node after a replication gap (missed cross-node
   * updates) — cheap (one storage read) and idempotent (providers apply unsolicited sync-step-2
   * without replying, so there is no sync loop).
   *
   * Coalesced leading+trailing: concurrent calls collapse into one storage read, but a gap that
   * arrives *during* an in-flight resync schedules exactly one more run afterward — so the
   * trailing gap (which may reflect newer storage state than the in-flight read captured) is
   * never dropped, which would otherwise leave the node silently stale.
   *
   * Only heals when storage is shared across nodes (the standard deployment). With per-node
   * storage, cross-node gaps are healed by durable replay instead.
   */
  async resyncLocalClientsFromStorage(): Promise<void> {
    if (this.#resyncInFlight) {
      // A resync is already running; remember that another gap arrived so we re-run once it ends.
      this.#resyncPending = true;
      return;
    }
    this.#resyncInFlight = true;
    try {
      do {
        this.#resyncPending = false;
        // The empty state-vector diff is the full document state (includes encrypted sidecars).
        const doc = await this.#storage.handleSyncStep1(
          this.namespacedDocumentId,
          getEmptyStateVector(),
        );
        const message = new DocMessage<Context>(
          this.documentId,
          {
            type: "sync-step-2",
            update: {
              version: 2,
              data: doc.content.update as unknown as SyncStep2UpdateV2,
            } as VersionedSyncStep2Update,
          },
          undefined,
          this.encrypted,
        );
        await this.broadcast(message);

        // Outbound heal: if one of this node's own durable publishes failed while it was
        // disconnected, remote nodes never saw a gap on their side — republish full state to the
        // document topic so they heal via the idempotent replication path (own-sourceId filter
        // prevents a local loop). The helper re-sets the flag if this publish fails again.
        if (this.#publishFailedSinceHeal) {
          this.#publishFailedSinceHeal = false;
          await this.#publishDocumentMessage(message).catch(() => {});
        }
      } while (this.#resyncPending);
    } finally {
      this.#resyncInFlight = false;
    }
  }

  /**
   * Write an update to the storage.
   */
  async write(
    update: VersionedUpdate,
    context?: Context,
    source: DocumentMessageSource = "client",
    clientId?: string,
  ) {
    try {
      let attribution: EncodedContentMap | undefined;
      if (source === "client" && context?.userId) {
        try {
          attribution = await this.#computeAttribution(update, context, clientId);
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

        // Only push when the attribution protocol is actually registered — otherwise no
        // client could interpret it. Keyed off the imported method definition rather than a
        // literal, so renaming a method can't silently turn this guard off.
        if (
          this.#storage.retrieveAttribution &&
          this.#rpcHandlers[attributionProtocol.methods.get.name]
        ) {
          this.broadcastRpc(
            attributionProtocol.methods.push.name,
            { contentMap: attribution },
            { excludeClientId: clientId },
          ).catch(() => {});
        }
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

  async #computeAttribution(update: VersionedUpdate, context: Context, clientId?: string) {
    const payload = decodeContentEncryptedPayload(update.data as EncryptedUpdatePayload);
    const attrUpdate = { version: 2, data: payload.structureUpdate } as unknown as VersionedUpdate;
    const contentIds = createContentIdsFromUpdate(attrUpdate);
    const now = Date.now();
    const userId = context.userId;

    const insertAttrs: ContentAttribute[] = [
      createContentAttribute("insert", userId),
      createContentAttribute("insertAt", now),
    ];
    const deleteAttrs: ContentAttribute[] = [
      createContentAttribute("delete", userId),
      createContentAttribute("deleteAt", now),
    ];

    if (this.#attributionConfig?.getAttributes) {
      const custom = await this.#attributionConfig.getAttributes({
        context,
        update,
        server: this.#server,
        clientId,
      });
      const customAttrs = recordToAttrs(custom);
      insertAttrs.push(...customAttrs);
      deleteAttrs.push(...customAttrs);
    }

    return encodeContentMap(createContentMapFromContentIds(contentIds, insertAttrs, deleteAttrs));
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
    // The `encrypted` flag describes whether the message payload needs
    // decryption — it is a property of the message, not the document.
    // Only `doc` messages must match the session's encryption mode because
    // the server processes their content differently per mode.  Presence and
    // RPC payloads are independent of the document's encryption state.
    if (message.type === "doc" && message.encrypted !== this.encrypted) {
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
                    update: {
                      version: 2,
                      data: doc.content.update as unknown as SyncStep2UpdateV2,
                    } as VersionedSyncStep2Update,
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

              await this.write(message.payload.update, message.context, messageSource, client?.id);

              await Promise.all([
                this.broadcast(message, client?.id),
                this.#publishDocumentMessage(message)
                  // A failed publish on the doc-update fan-out lane silently
                  // desyncs clients on other nodes; name it instead of
                  // folding it into the generic apply failure.
                  .catch((error) => {
                    emitWideEvent("error", {
                      event_type: "update_publish_failed",
                      timestamp: new Date().toISOString(),
                      document_id: this.documentId,
                      session_id: this.id,
                      message_id: message.id,
                      client_id: client?.id,
                      error,
                    });
                    throw error;
                  }),
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
              await Promise.all([
                this.broadcast(message, client?.id),
                this.#storage.handleSyncStep2(this.namespacedDocumentId, message.payload.update),
                this.#publishDocumentMessage(message),
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
          const rpcMessage = message as RpcMessage<Context>;
          const { requestType, originalRequestId } = rpcMessage;

          // A push is an unsolicited notification: a "response" correlated to no request. It
          // may arrive from a local client or replicated from another node (client undefined).
          if (requestType === "response" && originalRequestId === undefined) {
            await this.#handleRpcPush(rpcMessage, client, replicationMeta?.sourceNodeId);
            return;
          }

          // Everything else (requests, streams, request-correlated responses) is a
          // conversation with a specific local client; replicated copies are not ours.
          if (!client) {
            return;
          }

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
              if (!handler?.handler) {
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
                  // The server-assigned connection id, not the client-supplied context value —
                  // handlers keying state by clientId must not be spoofable.
                  clientId: client.id,
                };
                const result = (await handler.handler(requestPayload, enrichedContext)) as {
                  response: {
                    type: string;
                    payload?: unknown;
                    statusCode?: number;
                    details?: string;
                  };
                  stream?: AsyncIterable<unknown>;
                  encrypted?: boolean;
                };
                const responseEncrypted = result.encrypted ?? rpcMessage.encrypted;

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
                      responseEncrypted,
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
                  responseEncrypted,
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
                    clientId: client.id,
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
        default: {
          await Promise.all([
            this.broadcast(message, client?.id),
            this.#publishDocumentMessage(message),
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
    }, this.#cleanupDelayMs);
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

  /** Whether a client with this id is currently connected to the session. */
  public hasClient(id: string): boolean {
    return this.#clients.has(id);
  }
}
