import type { ServerContext } from "teleportal";
import { createHandlers, ok, type RpcHandlerRegistry, type RpcPushContext } from "teleportal/rpc";
import { emitWideEvent } from "../../server/logger";
import type { Session } from "../../server/session";
import { presenceProtocol, type PresenceEntry, type PresenceRosterPayload } from "./methods";

/**
 * Configuration for the presence protocol. Transport liveness (`clientTtlMs`,
 * the ping sweep) stays in the server core — it is a socket concern whose
 * `client-leave` event this protocol consumes.
 */
export type PresenceProtocolConfig<Context extends ServerContext = ServerContext> = {
  /**
   * Project a client's server context into the `data` bag broadcast to peers on
   * join/leave. Return only what is safe to share (e.g. a display name). May be
   * async (e.g. to look up a profile). Defaults to `() => ({})`.
   */
  getPresenceData?: (
    context: Context,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;

  /**
   * How often (ms) each node re-broadcasts a snapshot of its own local clients
   * over pub/sub so other nodes can keep a fresh, crash-safe roster, and pushes
   * the combined roster to its local clients. Defaults to 30_000 (30s). Set to
   * 0 to disable the maintenance timer (tests drive ticks manually).
   */
  heartbeatIntervalMs?: number;

  /**
   * How long (ms) a remote node's presence is trusted without a heartbeat.
   * When exceeded, the node is presumed gone and its clients are cleared from
   * peers. Should be a small multiple of `heartbeatIntervalMs`. Defaults to
   * 90_000 (90s, ~2 missed heartbeats).
   */
  presenceTtlMs?: number;

  /**
   * Minimum interval (ms) between roster refreshes (requests published on
   * session open / replication gap) and between answers to other nodes'
   * roster requests, per session. This is the storm brake: pub/sub backends
   * can fire gap events for every topic at once (e.g. a NATS stream purge),
   * and without coalescing each gap would trigger a cluster-wide
   * request-and-answer exchange per document. Defaults to 1_000. Set to 0 to
   * disable (tests).
   */
  rosterRefreshMinIntervalMs?: number;
};

/**
 * The presence of each connected local client, keyed by session client id,
 * then by announced awareness clientID. A client can hold *multiple*
 * awarenessIds at once: a SharedWorker multiplexes many tabs (each with its
 * own Y.Doc and awareness clientID) over one server connection.
 */
type LocalPresence = Map<string, Map<number, { userId: string; data: Record<string, unknown> }>>;

/**
 * Presence of clients connected to *other* nodes, keyed by node id, then by
 * `clientId:awarenessId`. Built from replicated join/leave pushes and roster
 * snapshots. Each node carries a `lastSeen` timestamp; a node whose heartbeats
 * stop is TTL-expired and its clients are cleared from peers (self-healing
 * across node crashes).
 */
type RemotePresence = Map<string, { lastSeen: number; clients: Map<string, PresenceEntry> }>;

type PresenceSessionState = {
  local: LocalPresence;
  remote: RemotePresence;
  timer: ReturnType<typeof setInterval> | undefined;
  unsubscribers: (() => void)[];
  /** Last time this session published a roster refresh (request + own snapshot). */
  lastRefreshAt: number;
  /** Last time this session answered another node's roster request. */
  lastAnswerAt: number;
};

function localSnapshot(state: PresenceSessionState): PresenceEntry[] {
  return [...state.local.entries()].flatMap(([clientId, entries]) =>
    [...entries.entries()].map(([awarenessId, presence]) => ({
      awarenessId,
      clientId,
      userId: presence.userId,
      data: presence.data,
    })),
  );
}

/** Is this awarenessId currently announced by one of OUR local clients? */
function locallyOwned(state: PresenceSessionState, awarenessId: number): boolean {
  for (const entries of state.local.values()) {
    if (entries.has(awarenessId)) {
      return true;
    }
  }
  return false;
}

/**
 * Is this awarenessId still represented by any source other than
 * `excludeNodeId` — a local client or another remote node? A leave for an
 * awarenessId that is known elsewhere must be suppressed: the id did not
 * die, it moved (cross-node reconnect), and forwarding the stale leave would
 * clobber the live presence and destroy its awareness state on every client.
 */
function knownElsewhere(
  state: PresenceSessionState,
  awarenessId: number,
  excludeNodeId?: string,
): boolean {
  if (locallyOwned(state, awarenessId)) {
    return true;
  }
  for (const [nodeId, node] of state.remote) {
    if (nodeId === excludeNodeId) {
      continue;
    }
    for (const entry of node.clients.values()) {
      if (entry.awarenessId === awarenessId) {
        return true;
      }
    }
  }
  return false;
}

/**
 * The full roster (this node's local clients + clients on other nodes),
 * deduplicated by awarenessId with local entries winning (during a
 * cross-node reconnect the same awarenessId can transiently exist both
 * locally and in a remote node's not-yet-reconciled snapshot). This is what
 * clients reconcile against — unlike the node-to-node roster, which carries
 * only local clients.
 */
function combinedSnapshot(state: PresenceSessionState): PresenceEntry[] {
  const byAwarenessId = new Map<number, PresenceEntry>();
  for (const node of state.remote.values()) {
    for (const entry of node.clients.values()) {
      byAwarenessId.set(entry.awarenessId, entry);
    }
  }
  for (const entry of localSnapshot(state)) {
    byAwarenessId.set(entry.awarenessId, entry);
  }
  return [...byAwarenessId.values()];
}

/**
 * Fan a server-authored join/leave out to this node's local clients only.
 * Replication is intentionally off: these pushes describe *another* node's
 * clients (or are already replicated by their originating path), so
 * re-publishing them would echo them around the cluster.
 */
function broadcastLocalOnly(
  session: Session<ServerContext>,
  method: string,
  payload: unknown,
): Promise<void> {
  return session.broadcastRpc(method, payload, { qos: { replicate: false } });
}

/**
 * Build the RPC handler registry for presence. Registered by default by the
 * `Server` (opt out with `presence: false` and register your own to swap the
 * implementation).
 */
export function getPresenceRpcHandlers<Context extends ServerContext = ServerContext>(
  config: PresenceProtocolConfig<Context> = {},
): RpcHandlerRegistry {
  const heartbeatIntervalMs = config.heartbeatIntervalMs ?? 30_000;
  const presenceTtlMs = config.presenceTtlMs ?? 90_000;
  const rosterRefreshMinIntervalMs = config.rosterRefreshMinIntervalMs ?? 1_000;

  const sessionStates = new WeakMap<Session<ServerContext>, PresenceSessionState>();
  const trackedSessions = new Set<Session<ServerContext>>();

  function stateFor(session: Session<ServerContext>): PresenceSessionState {
    let state = sessionStates.get(session);
    if (!state) {
      state = {
        local: new Map(),
        remote: new Map(),
        timer: undefined,
        unsubscribers: [],
        lastRefreshAt: 0,
        lastAnswerAt: 0,
      };
      sessionStates.set(session, state);
    }
    return state;
  }

  /**
   * Resolve the integrator-configured presence `data` for a client context,
   * tolerating a throwing or rejecting projection.
   */
  async function getPresenceData(
    session: Session<ServerContext>,
    context: Context,
  ): Promise<Record<string, unknown>> {
    if (!config.getPresenceData) {
      return {};
    }
    try {
      return await config.getPresenceData(context);
    } catch (error) {
      emitWideEvent("error", {
        event_type: "presence_data_failed",
        timestamp: new Date().toISOString(),
        document_id: session.documentId,
        session_id: session.id,
        client_id: context.clientId,
        error,
      });
      return {};
    }
  }

  /**
   * Record/refresh a single remote client (from a replicated join push), so
   * the cross-node roster stays current between heartbeats.
   */
  function upsertRemoteClient(state: PresenceSessionState, nodeId: string, entry: PresenceEntry) {
    const node = state.remote.get(nodeId) ?? {
      lastSeen: Date.now(),
      clients: new Map<string, PresenceEntry>(),
    };
    node.lastSeen = Date.now();
    node.clients.set(`${entry.clientId}:${entry.awarenessId}`, entry);
    state.remote.set(nodeId, node);
  }

  /**
   * Forget a single remote awarenessId (from a replicated leave push).
   */
  function removeRemoteClient(state: PresenceSessionState, nodeId: string, entry: PresenceEntry) {
    const node = state.remote.get(nodeId);
    if (!node) {
      return;
    }
    node.lastSeen = Date.now();
    node.clients.delete(`${entry.clientId}:${entry.awarenessId}`);
    if (node.clients.size === 0) {
      state.remote.delete(nodeId);
    }
  }

  /**
   * Reconcile a node's full roster snapshot against what we last knew for it:
   * fan out joins for newly-seen clients, leaves for clients that disappeared,
   * then store the snapshot and refresh the node's liveness. Self-heals any
   * join/leave push that was lost.
   */
  async function reconcileRemoteSnapshot(
    session: Session<ServerContext>,
    state: PresenceSessionState,
    nodeId: string,
    clients: PresenceEntry[],
  ) {
    const previous = state.remote.get(nodeId)?.clients ?? new Map<string, PresenceEntry>();
    const next = new Map<string, PresenceEntry>();
    const nextAwarenessIds = new Set<number>();
    const sends: Promise<void>[] = [];

    for (const peer of clients) {
      const key = `${peer.clientId}:${peer.awarenessId}`;
      next.set(key, peer);
      nextAwarenessIds.add(peer.awarenessId);
      // A join for an awarenessId one of our own clients owns is a stale
      // remote claim from before a cross-node reconnect — don't forward it
      // over the live local entry.
      if (!previous.has(key) && !locallyOwned(state, peer.awarenessId)) {
        sends.push(broadcastLocalOnly(session, "presenceJoin", peer));
      }
    }

    for (const [key, peer] of previous) {
      if (next.has(key)) {
        continue;
      }
      // The key disappeared but the awarenessId did not die: it re-announced
      // on the same remote node under a new connection (still in the
      // snapshot), moved to this node, or moved to another node. Only a
      // genuinely gone awarenessId produces a leave.
      if (
        nextAwarenessIds.has(peer.awarenessId) ||
        knownElsewhere(state, peer.awarenessId, nodeId)
      ) {
        continue;
      }
      sends.push(broadcastLocalOnly(session, "presenceLeave", peer));
    }

    state.remote.set(nodeId, { lastSeen: Date.now(), clients: next });
    await Promise.all(sends);
  }

  /**
   * Tell peers a client left so they clear its awareness locally. Works for
   * encrypted documents because the awareness clientID travels in cleartext.
   */
  function broadcastClientLeave(session: Session<ServerContext>, clientId: string) {
    const state = sessionStates.get(session);
    const entries = state?.local.get(clientId);
    state?.local.delete(clientId);
    if (!entries || !state) {
      return;
    }
    const sends: Promise<unknown>[] = [];
    for (const [awarenessId, presence] of entries) {
      // The awarenessId is still alive somewhere else (another local client
      // after a same-node transfer, or another node after a cross-node
      // reconnect): this connection's death is not the peer's death.
      if (knownElsewhere(state, awarenessId)) {
        continue;
      }
      sends.push(
        session.broadcastRpc(
          "presenceLeave",
          {
            awarenessId,
            clientId,
            userId: presence.userId,
            data: presence.data,
          } satisfies PresenceEntry,
          { excludeClientId: clientId },
        ),
      );
    }
    void Promise.all(sends).catch((error) => {
      emitWideEvent("error", {
        event_type: "presence_leave_broadcast_failed",
        timestamp: new Date().toISOString(),
        document_id: session.documentId,
        session_id: session.id,
        client_id: clientId,
        error,
      });
    });
  }

  /**
   * One presence-maintenance tick: advertise this node's local clients to
   * other nodes, expire any remote node that has stopped sending heartbeats
   * (e.g. crashed) and clear its clients locally, then push the FULL roster
   * to this node's own clients so any lost join/leave self-heals within one
   * heartbeat interval. Exported via the registry entry's session listener;
   * tests drive it through `runPresenceMaintenance`.
   */
  async function runMaintenanceTick(session: Session<ServerContext>) {
    const state = stateFor(session);
    const sends: Promise<unknown>[] = [];

    const snapshot = localSnapshot(state);
    if (snapshot.length > 0) {
      sends.push(
        session.publishRpc("presenceRoster", { clients: snapshot } satisfies PresenceRosterPayload),
      );
    }

    const now = Date.now();
    for (const [nodeId, node] of state.remote) {
      if (now - node.lastSeen <= presenceTtlMs) {
        continue;
      }
      state.remote.delete(nodeId);
      for (const peer of node.clients.values()) {
        // Expired node, but the awarenessId lives on elsewhere (it moved) —
        // don't clobber the live presence.
        if (knownElsewhere(state, peer.awarenessId)) {
          continue;
        }
        sends.push(broadcastLocalOnly(session, "presenceLeave", peer));
      }
    }

    // The combined roster is sent even when empty — an empty roster is exactly
    // what tells a client its last remaining peer is gone. Built after the TTL
    // expiry above so it never resurrects clients of a node that was just
    // expired.
    sends.push(
      broadcastLocalOnly(session, "presenceRoster", {
        clients: combinedSnapshot(state),
      } satisfies PresenceRosterPayload),
    );

    await Promise.all(sends).catch((error) => {
      emitWideEvent("error", {
        event_type: "presence_maintenance_failed",
        timestamp: new Date().toISOString(),
        document_id: session.documentId,
        session_id: session.id,
        error,
      });
    });
  }

  /**
   * Ask every node on the topic to publish its roster now, and publish our
   * own alongside so the whole network refreshes symmetrically. A pull beats
   * waiting for the next heartbeat when a node just opened the session (empty
   * cross-node roster) or detected a replication gap (possibly stale roster).
   */
  async function requestRosterRefresh(session: Session<ServerContext>) {
    const state = stateFor(session);
    // Storm brake: gap events can arrive in bursts (a durable backend may
    // fire one per topic for a single incident); one refresh answers them all.
    if (rosterRefreshMinIntervalMs > 0) {
      const now = Date.now();
      if (now - state.lastRefreshAt < rosterRefreshMinIntervalMs) {
        return;
      }
      state.lastRefreshAt = now;
    }
    const sends: Promise<unknown>[] = [session.publishRpc("presenceRosterRequest", {})];
    const snapshot = localSnapshot(state);
    if (snapshot.length > 0) {
      sends.push(
        session.publishRpc("presenceRoster", { clients: snapshot } satisfies PresenceRosterPayload),
      );
    }
    await Promise.all(sends).catch((error) => {
      emitWideEvent("error", {
        event_type: "presence_roster_refresh_failed",
        timestamp: new Date().toISOString(),
        document_id: session.documentId,
        session_id: session.id,
        error,
      });
    });
  }

  /**
   * Server-authored pushes must not be forgeable by clients: a client-authored
   * join/leave/roster push (ctx.clientId set) is dropped, not applied — and
   * `replicate: false` keeps the forgery off pub/sub, where other nodes would
   * see it as a trusted node-to-node message. On the happy path the inner
   * handler's result (forwarding decision) is passed through.
   */
  function replicatedOnly(
    handler: (
      state: PresenceSessionState,
      ctx: RpcPushContext,
      payload: any,
    ) =>
      | { forwardToLocalClients: boolean }
      | undefined
      | Promise<{ forwardToLocalClients: boolean } | undefined>,
  ) {
    return async (payload: unknown, ctx: RpcPushContext) => {
      if (ctx.clientId !== undefined || ctx.sourceNodeId === undefined) {
        return { forwardToLocalClients: false as const, replicate: false as const };
      }
      const session = ctx.session as Session<ServerContext>;
      return await handler(stateFor(session), ctx, payload);
    };
  }

  const registry = createHandlers(
    presenceProtocol,
    { sessionStates },
    {
      announce:
        () =>
        async ({ awarenessId }, ctx) => {
          const session = ctx.session as Session<ServerContext>;
          const clientId = ctx.clientId;
          if (typeof clientId !== "string") {
            return ok({});
          }
          const state = stateFor(session);
          const userId = (ctx.userId as string | undefined) ?? "";
          const data = await getPresenceData(session, ctx as unknown as Context);

          // `getPresenceData` may be async, so the client could have
          // disconnected while we were suspended — in which case `client-leave`
          // has already fired (and will never fire again for this clientId).
          // Recording the entry now would leave a permanent ghost peer, so bail.
          if (!session.hasClient(clientId)) {
            return ok({});
          }

          // An awarenessId is bound to one Y.Doc instance, so an announce from
          // a different client means that doc reconnected on a new connection
          // while the old one is still lingering. Transfer ownership silently
          // — no leave, the awareness never died — so the old connection's
          // eventual disconnect doesn't clobber the live presence.
          for (const [otherId, otherEntries] of state.local) {
            if (
              otherId !== clientId &&
              otherEntries.delete(awarenessId) &&
              otherEntries.size === 0
            ) {
              state.local.delete(otherId);
            }
          }

          // A client can announce several awarenessIds (one per SharedWorker
          // tab); each gets its own entry. Re-announcing an existing id (e.g.
          // after a reconnect) just refreshes its data.
          let entries = state.local.get(clientId);
          if (!entries) {
            entries = new Map();
            state.local.set(clientId, entries);
          }
          entries.set(awarenessId, { userId, data });

          const newEntry: PresenceEntry = { awarenessId, clientId, userId, data };
          const sends: Promise<unknown>[] = [];

          // Tell already-announced peers that the newcomer joined. Peers that
          // have not announced yet are skipped — they will receive the newcomer
          // in their own roster when they announce. Other nodes get the join
          // via pub/sub.
          for (const otherId of state.local.keys()) {
            if (otherId === clientId) {
              continue;
            }
            sends.push(session.sendRpcToClient(otherId, "presenceJoin", newEntry));
          }
          sends.push(session.publishRpc("presenceJoin", newEntry));

          // Close the roster exchange with a full snapshot (local + cross-node)
          // to the announcing connection. It replaces the historical per-peer
          // join replay: the client's reconcile emits peer-join per entry, and
          // a SharedWorker fans it out to every sibling tab — the announcer's
          // own entries are included on purpose so those tabs learn about each
          // other (each tab drops its own awarenessId client-side).
          sends.push(
            session.sendRpcToClient(clientId, "presenceRoster", {
              clients: combinedSnapshot(state),
            } satisfies PresenceRosterPayload),
          );

          await Promise.all(sends).catch((error) => {
            emitWideEvent("error", {
              event_type: "presence_join_broadcast_failed",
              timestamp: new Date().toISOString(),
              document_id: session.documentId,
              session_id: session.id,
              client_id: clientId,
              error,
            });
          });

          return ok({});
        },

      unannounce:
        () =>
        async ({ awarenessId }, ctx) => {
          const session = ctx.session as Session<ServerContext>;
          const clientId = ctx.clientId;
          if (typeof clientId !== "string") {
            return ok({});
          }
          const state = stateFor(session);
          const entries = state.local.get(clientId);
          const presence = entries?.get(awarenessId);
          if (!entries || !presence) {
            return ok({});
          }
          entries.delete(awarenessId);
          if (entries.size === 0) {
            state.local.delete(clientId);
          }
          // Not excluding the sender: sibling tabs on the same SharedWorker
          // connection need the leave too (the retracting tab is gone or drops
          // its own awarenessId client-side).
          await session
            .broadcastRpc("presenceLeave", {
              awarenessId,
              clientId,
              userId: presence.userId,
              data: presence.data,
            } satisfies PresenceEntry)
            .catch((error) => {
              emitWideEvent("error", {
                event_type: "presence_leave_broadcast_failed",
                timestamp: new Date().toISOString(),
                document_id: session.documentId,
                session_id: session.id,
                client_id: clientId,
                error,
              });
            });
          return ok({});
        },

      // Replicated joins/leaves update the cross-node roster and relay to
      // local clients — unless the awarenessId is alive under another owner
      // (cross-node reconnect), in which case the stale signal is absorbed.
      join: () =>
        replicatedOnly((state, ctx, entry: PresenceEntry) => {
          upsertRemoteClient(state, ctx.sourceNodeId!, entry);
          return { forwardToLocalClients: !locallyOwned(state, entry.awarenessId) };
        }),

      leave: () =>
        replicatedOnly((state, ctx, entry: PresenceEntry) => {
          removeRemoteClient(state, ctx.sourceNodeId!, entry);
          return { forwardToLocalClients: !knownElsewhere(state, entry.awarenessId) };
        }),

      // A node-to-node roster is NOT forwarded raw: reconciliation emits its
      // own join/leave pushes, and local clients receive the *combined* roster
      // from the local maintenance tick instead.
      roster: () =>
        replicatedOnly(async (state, ctx, payload: PresenceRosterPayload) => {
          await reconcileRemoteSnapshot(
            ctx.session as Session<ServerContext>,
            state,
            ctx.sourceNodeId!,
            payload.clients,
          );
          return { forwardToLocalClients: false as const };
        }),

      // Another node asked for rosters (it just opened the session or hit a
      // replication gap): answer by publishing our local snapshot immediately,
      // throttled so a request storm is answered once per window. Local
      // clients never see the request itself.
      rosterRequest: () =>
        replicatedOnly(async (state, ctx) => {
          const suppress = { forwardToLocalClients: false as const };
          if (rosterRefreshMinIntervalMs > 0) {
            const now = Date.now();
            if (now - state.lastAnswerAt < rosterRefreshMinIntervalMs) {
              return suppress;
            }
          }
          const snapshot = localSnapshot(state);
          if (snapshot.length === 0) {
            // Nothing published, so don't consume the window: the first
            // answer after this node gains a client must not be suppressed.
            return suppress;
          }
          state.lastAnswerAt = Date.now();
          await (ctx.session as Session<ServerContext>).publishRpc("presenceRoster", {
            clients: snapshot,
          } satisfies PresenceRosterPayload);
          return suppress;
        }),
    },
    {
      init: (server) => {
        const unsubscribers: (() => void)[] = [];

        function setupSession(session: Session<ServerContext>): void {
          if (trackedSessions.has(session)) return;
          trackedSessions.add(session);
          const state = stateFor(session);

          if (heartbeatIntervalMs > 0) {
            state.timer = setInterval(() => {
              void runMaintenanceTick(session);
            }, heartbeatIntervalMs);
            // Don't keep the process alive solely for presence heartbeats.
            (state.timer as { unref?: () => void }).unref?.();
          }

          state.unsubscribers.push(
            session.on("client-leave", ({ clientId }) => {
              broadcastClientLeave(session, clientId);
            }),
            session.on("replication-gap", () => {
              void requestRosterRefresh(session);
            }),
            session.on("dispose", () => {
              if (state.timer !== undefined) {
                clearInterval(state.timer);
                state.timer = undefined;
              }
              state.unsubscribers.forEach((fn) => fn());
              state.unsubscribers.length = 0;
              state.local.clear();
              state.remote.clear();
              trackedSessions.delete(session);
            }),
          );
        }

        unsubscribers.push(
          server.on("session-open", ({ session }) => {
            setupSession(session as Session<ServerContext>);
            // The session's pub/sub subscription is live before session-open
            // fires (Server awaits session.load() first), so responses to
            // this pull cannot be missed. Without it a fresh node would show
            // an empty cross-node roster until the next heartbeat.
            void requestRosterRefresh(session as Session<ServerContext>);
          }),
        );

        return () => {
          for (const session of trackedSessions) {
            const state = sessionStates.get(session);
            if (state) {
              if (state.timer !== undefined) {
                clearInterval(state.timer);
                state.timer = undefined;
              }
              state.unsubscribers.forEach((fn) => fn());
              state.unsubscribers.length = 0;
            }
          }
          trackedSessions.clear();
          unsubscribers.forEach((fn) => fn());
          unsubscribers.length = 0;
        };
      },
    },
  );

  // Expose the tick for deterministic driving in tests (see
  // runPresenceMaintenance); the interval set up in init calls it directly.
  (registry.presenceRoster as PresenceRosterEntry).__tick = runMaintenanceTick;

  return registry;
}

type PresenceRosterEntry = RpcHandlerRegistry[string] & {
  __tick?: (session: Session<ServerContext>) => Promise<void>;
};

/**
 * Drive one maintenance tick for a session deterministically (tests). The
 * registry must be the one produced by {@link getPresenceRpcHandlers}.
 */
export async function runPresenceMaintenance(
  registry: RpcHandlerRegistry,
  session: Session<ServerContext>,
): Promise<void> {
  await (registry.presenceRoster as PresenceRosterEntry).__tick?.(session);
}
