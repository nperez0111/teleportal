import { removeAwarenessStates } from "y-protocols/awareness";
import type { RpcMessage } from "teleportal/protocol";
import type { RpcExtension, RpcExtensionContext } from "teleportal/rpc";
import { Observable } from "../../lib/utils";
import type { PresenceEntry } from "./methods";

/** A present peer, as surfaced to application code (`provider.peers`). */
export type PresenceEvent = PresenceEntry;

export type PresenceExtensionOptions = {
  /**
   * How long (ms) after a disconnect before all remote presence and awareness
   * is cleared, so an offline provider reports no peers rather than a stale
   * roster. `Infinity` disables. Defaults to 30_000.
   */
  offlineTimeoutMs?: number;
  /**
   * How recently a peer must have joined for a roster reconcile to spare it
   * from removal: a snapshot built just before the peer's join legitimately
   * lacks it. Long enough to cover announce/roster write interleaving on the
   * server, short relative to the server's heartbeat interval (30s) so real
   * ghosts still heal on the next roster. Defaults to 5_000.
   */
  presenceJoinGraceMs?: number;
};

export type PresenceApi = Observable<{
  "peer-join": (peer: PresenceEvent) => void;
  "peer-leave": (peer: PresenceEvent) => void;
}> & {
  readonly peers: ReadonlyMap<number, PresenceEvent>;
};

const PUSH_METHODS = new Set(["presenceJoin", "presenceLeave", "presenceRoster"]);

class PresenceClient extends Observable<{
  "peer-join": (peer: PresenceEvent) => void;
  "peer-leave": (peer: PresenceEvent) => void;
}> {
  readonly #ctx: RpcExtensionContext;
  readonly #offlineTimeoutMs: number;
  readonly #presenceJoinGraceMs: number;

  /**
   * The peers currently believed present (keyed by awareness clientID),
   * maintained from join/leave pushes and reconciled against the server's
   * periodic roster snapshots.
   */
  readonly #peers = new Map<number, PresenceEvent>();
  /** When each peer joined — powers the reconcile join-grace window. */
  readonly #peerJoinedAt = new Map<number, number>();
  /**
   * Awareness ids ever seen on THIS document's roster. The ghost-state sweep
   * only forgets states it knows belong here — a shared awareness instance
   * (subdocs) carries states from other documents this roster knows nothing
   * about.
   */
  readonly #everRosteredIds = new Set<number>();
  /** First time an awareness state was seen without a roster entry (ghost candidate). */
  readonly #unrosteredStateSince = new Map<number, number>();
  #offlineClearTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #unsubscribeConnection: () => void;

  constructor(ctx: RpcExtensionContext, options: PresenceExtensionOptions) {
    super();
    this.#ctx = ctx;
    this.#offlineTimeoutMs = options.offlineTimeoutMs ?? 30_000;
    this.#presenceJoinGraceMs = options.presenceJoinGraceMs ?? 5_000;

    // Presence honesty while offline: once the connection is lost, this
    // client can no longer learn about joins/leaves, so after a grace period
    // stop claiming peers are present. Reconnect within the grace period
    // cancels the clear; reconnect after it rebuilds the roster from the
    // server (roster reply + join pushes + awareness-request).
    this.#unsubscribeConnection = ctx.connection.on("update", (state: { type: string }) => {
      if (state.type === "connected") {
        this.#cancelOfflineClear();
      } else if (state.type === "disconnected" || state.type === "errored") {
        this.#scheduleOfflineClear();
      }
    });
  }

  get peers(): ReadonlyMap<number, PresenceEvent> {
    return this.#peers;
  }

  /** Announce this provider's awareness clientID (fire-and-forget). */
  announce(): void {
    this.#ctx.rpcClient
      .sendRequest(this.#ctx.document, "presenceAnnounce", {
        awarenessId: this.#ctx.awareness.clientID,
      })
      .catch(() => {
        // Best-effort: a lost announce is healed by the next reconnect's
        // announce or the server's roster push.
      });
  }

  /** Retract this provider's awareness clientID (fire-and-forget, on destroy). */
  unannounce(): void {
    // Fire-and-forget without awaiting `connected`: this runs from
    // `provider.destroy()`, which tears down the connection synchronously right
    // after. Awaiting `connected` would defer the send to a microtask that runs
    // after the connection is destroyed, dropping the unannounce entirely.
    this.#ctx.rpcClient.sendFireAndForget(this.#ctx.document, "presenceUnannounce", {
      awarenessId: this.#ctx.awareness.clientID,
    });
  }

  /** Route an incoming RPC message; returns true when consumed. */
  handleMessage(message: RpcMessage<any>): boolean {
    if (message.requestType !== "response" || !PUSH_METHODS.has(message.rpcMethod)) {
      return false;
    }
    if (message.payload.type !== "success") {
      return true;
    }
    const payload = message.payload.payload;

    // The server's roster is the full truth at a point in time: reconcile
    // against it so any join/leave this client missed (dropped push, brief
    // offline window) heals instead of persisting forever.
    if (message.rpcMethod === "presenceRoster") {
      this.#reconcilePeers((payload as { clients: PresenceEntry[] }).clients);
      return true;
    }

    const entry = payload as PresenceEntry;
    if (entry.awarenessId === this.#ctx.awareness.clientID) {
      return true;
    }
    if (message.rpcMethod === "presenceLeave") {
      this.#peers.delete(entry.awarenessId);
      this.#peerJoinedAt.delete(entry.awarenessId);
      this.#forgetAwarenessStates([entry.awarenessId], "presence");
      this.call("peer-leave", entry);
    } else {
      const isNew = !this.#peers.has(entry.awarenessId);
      this.#peers.set(entry.awarenessId, entry);
      this.#everRosteredIds.add(entry.awarenessId);
      this.#unrosteredStateSince.delete(entry.awarenessId);
      if (isNew) {
        this.#peerJoinedAt.set(entry.awarenessId, Date.now());
      }
      this.call("peer-join", entry);
    }
    return true;
  }

  /**
   * Remove remote awareness states AND their clock meta. Dropping the meta
   * matters: y-protocols rejects an incoming non-null state whose clock
   * hasn't advanced, so a peer's re-sent (unchanged) state — e.g. its reply
   * to our reconnect awareness-request — would otherwise be ignored and its
   * cursor would stay invisible until it next moved.
   */
  #forgetAwarenessStates(awarenessIds: number[], origin: string) {
    removeAwarenessStates(this.#ctx.awareness, awarenessIds, origin);
    for (const id of awarenessIds) {
      this.#ctx.awareness.meta.delete(id);
      this.#unrosteredStateSince.delete(id);
    }
  }

  /**
   * Replace the peer roster with the server's snapshot: join newly-seen
   * peers, leave (and clear awareness for) peers absent from the snapshot,
   * silently refresh the rest.
   */
  #reconcilePeers(clients: PresenceEntry[]) {
    const now = Date.now();
    const seen = new Set<number>();
    for (const entry of clients) {
      if (entry.awarenessId === this.#ctx.awareness.clientID) continue;
      seen.add(entry.awarenessId);
      this.#everRosteredIds.add(entry.awarenessId);
      this.#unrosteredStateSince.delete(entry.awarenessId);
      const isNew = !this.#peers.has(entry.awarenessId);
      this.#peers.set(entry.awarenessId, entry);
      if (isNew) {
        this.#peerJoinedAt.set(entry.awarenessId, now);
        this.call("peer-join", entry);
      }
    }
    for (const [awarenessId, peer] of this.#peers) {
      if (seen.has(awarenessId)) continue;
      // Join-protection: a snapshot built just before this peer's join
      // legitimately lacks it — don't drop a fresh join over a stale
      // snapshot. If the peer is truly gone, the next roster (or its
      // leave push) removes it.
      const joinedAt = this.#peerJoinedAt.get(awarenessId) ?? 0;
      if (now - joinedAt < this.#presenceJoinGraceMs) continue;
      this.#peers.delete(awarenessId);
      this.#peerJoinedAt.delete(awarenessId);
      this.#forgetAwarenessStates([awarenessId], "presence");
      this.call("peer-leave", peer);
    }

    // Ghost-state sweep: an awareness state can outlive its presence — a
    // departing peer's final update may arrive AFTER its leave push (it was
    // already buffered when the socket closed) and re-add the state without
    // any roster entry, where the #peers loop above can't see it. The roster
    // snapshot is the truth: forget states whose owner is absent from it.
    // Scoped to ids ever rostered on THIS document (shared-awareness safety,
    // see #everRosteredIds) and grace-timed like peer removals.
    for (const awarenessId of this.#ctx.awareness.getStates().keys()) {
      if (awarenessId === this.#ctx.awareness.clientID) continue;
      if (seen.has(awarenessId) || this.#peers.has(awarenessId)) continue;
      if (!this.#everRosteredIds.has(awarenessId)) continue;
      const since = this.#unrosteredStateSince.get(awarenessId) ?? now;
      this.#unrosteredStateSince.set(awarenessId, since);
      if (now - since < this.#presenceJoinGraceMs) continue;
      this.#unrosteredStateSince.delete(awarenessId);
      this.#forgetAwarenessStates([awarenessId], "presence");
    }
  }

  #scheduleOfflineClear() {
    if (this.#offlineClearTimer !== null) return;
    if (!Number.isFinite(this.#offlineTimeoutMs)) return;
    if (this.#offlineTimeoutMs <= 0) {
      this.#clearRemotePresence();
      return;
    }
    this.#offlineClearTimer = setTimeout(() => {
      this.#offlineClearTimer = null;
      this.#clearRemotePresence();
    }, this.#offlineTimeoutMs);
    (this.#offlineClearTimer as unknown as { unref?: () => void }).unref?.();
  }

  #cancelOfflineClear() {
    if (this.#offlineClearTimer !== null) {
      clearTimeout(this.#offlineClearTimer);
      this.#offlineClearTimer = null;
    }
  }

  /**
   * Forget every remote peer: remove all remote awareness states (not just
   * announced peers, so an awareness state whose join we never saw is cleared
   * too) and emit `peer-leave` for each known peer.
   */
  #clearRemotePresence() {
    const remoteAwarenessIds = [...this.#ctx.awareness.getStates().keys()].filter(
      (id) => id !== this.#ctx.awareness.clientID,
    );
    if (remoteAwarenessIds.length > 0) {
      this.#forgetAwarenessStates(remoteAwarenessIds, "offline");
    }
    const peers = [...this.#peers.values()];
    this.#peers.clear();
    this.#peerJoinedAt.clear();
    this.#unrosteredStateSince.clear();
    for (const peer of peers) {
      this.call("peer-leave", peer);
    }
  }

  dispose() {
    this.unannounce();
    this.#cancelOfflineClear();
    this.#unsubscribeConnection();
    super.destroy();
  }
}

/**
 * The presence client extension. Registered by default by the `Provider`
 * under `rpc.presence`; `provider.peers` and the `peer-join`/`peer-leave`
 * events delegate to it.
 */
export function createPresenceExtension(
  options: PresenceExtensionOptions = {},
): () => RpcExtension<PresenceApi> {
  return () => {
    let client: PresenceClient | undefined;
    return {
      create(ctx: RpcExtensionContext): PresenceApi {
        client = new PresenceClient(ctx, options);
        return client;
      },
      handleMessage(message: RpcMessage<any>): boolean {
        return client?.handleMessage(message) ?? false;
      },
      onConnect() {
        client?.announce();
      },
      destroy() {
        client?.dispose();
      },
    };
  };
}
