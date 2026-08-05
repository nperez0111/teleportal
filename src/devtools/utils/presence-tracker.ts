import type { Message, RawReceivedMessage, RpcMessage } from "teleportal";
import type { PresenceEntry, PresenceRosterPayload } from "../../protocols/presence/methods";

export type PresencePeer = {
  awarenessId: number;
  clientId: string;
  userId: string;
  data: Record<string, unknown>;
  /** Document the presence message arrived on. */
  document: string | undefined;
  joinedAt: number;
  lastSeen: number;
};

export type PresenceFeedEntry = {
  timestamp: number;
  kind: "join" | "leave";
  userId: string;
  clientId: string;
};

const FEED_LIMIT = 50;

/**
 * Live peer roster derived from the presence protocol's RPC push stream
 * (presenceJoin / presenceLeave / presenceRoster).
 */
export class PresenceTracker {
  private peers = new Map<string, PresencePeer>();
  private feed: PresenceFeedEntry[] = [];

  /** Returns true when the roster or feed changed. */
  recordMessage(message: Message | RawReceivedMessage): boolean {
    if (message.type !== "rpc") return false;
    const rpc = message as RpcMessage<Record<string, unknown>>;
    // Pushes only (server-authored notifications): a "response" to no request.
    if (rpc.requestType !== "response" || rpc.originalRequestId !== undefined) return false;
    if (rpc.payload.type !== "success") return false;
    const now = Date.now();

    switch (rpc.rpcMethod) {
      case "presenceJoin": {
        const entry = rpc.payload.payload as PresenceEntry;
        return this.upsertPeer(entry, message.document, now);
      }

      case "presenceLeave": {
        const entry = rpc.payload.payload as PresenceEntry;
        const removed = this.peers.delete(entry.clientId);
        if (removed) {
          this.pushFeed({
            timestamp: now,
            kind: "leave",
            userId: entry.userId,
            clientId: entry.clientId,
          });
        }
        return removed;
      }

      case "presenceRoster": {
        // A roster carries a snapshot — upsert its entries, but don't remove
        // absent peers (a node-to-node roster carries only one node's clients).
        const { clients } = rpc.payload.payload as PresenceRosterPayload;
        let changed = false;
        for (const client of clients) {
          changed = this.upsertPeer(client, message.document, now) || changed;
        }
        return changed || clients.length > 0;
      }

      default:
        return false;
    }
  }

  private upsertPeer(entry: PresenceEntry, document: string | undefined, now: number): boolean {
    const existing = this.peers.get(entry.clientId);
    this.peers.set(entry.clientId, {
      awarenessId: entry.awarenessId,
      clientId: entry.clientId,
      userId: entry.userId,
      data: entry.data,
      document,
      joinedAt: existing?.joinedAt ?? now,
      lastSeen: now,
    });
    if (!existing) {
      this.pushFeed({
        timestamp: now,
        kind: "join",
        userId: entry.userId,
        clientId: entry.clientId,
      });
    }
    return true;
  }

  private pushFeed(entry: PresenceFeedEntry) {
    this.feed.push(entry);
    if (this.feed.length > FEED_LIMIT) {
      this.feed.splice(0, this.feed.length - FEED_LIMIT);
    }
  }

  /** The roster is per-connection; peers re-join after a reconnect. */
  clearPeers(): boolean {
    if (this.peers.size === 0) return false;
    this.peers.clear();
    return true;
  }

  getPeers(): PresencePeer[] {
    return [...this.peers.values()].sort((a, b) => a.joinedAt - b.joinedAt);
  }

  getFeed(): PresenceFeedEntry[] {
    return this.feed;
  }
}
