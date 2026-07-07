import type { Message, RawReceivedMessage } from "teleportal";

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
 * Live peer roster derived from the presence message stream
 * (presence-join / presence-leave / presence-heartbeat).
 */
export class PresenceTracker {
  private peers = new Map<string, PresencePeer>();
  private feed: PresenceFeedEntry[] = [];

  /** Returns true when the roster or feed changed. */
  recordMessage(message: Message | RawReceivedMessage): boolean {
    if (message.type !== "presence") return false;
    const payload = message.payload;
    const now = Date.now();

    switch (payload.type) {
      case "presence-join": {
        const existing = this.peers.get(payload.clientId);
        this.peers.set(payload.clientId, {
          awarenessId: payload.awarenessId,
          clientId: payload.clientId,
          userId: payload.userId,
          data: payload.data,
          document: message.document,
          joinedAt: existing?.joinedAt ?? now,
          lastSeen: now,
        });
        if (!existing) {
          this.pushFeed({
            timestamp: now,
            kind: "join",
            userId: payload.userId,
            clientId: payload.clientId,
          });
        }
        return true;
      }

      case "presence-leave": {
        const removed = this.peers.delete(payload.clientId);
        if (removed) {
          this.pushFeed({
            timestamp: now,
            kind: "leave",
            userId: payload.userId,
            clientId: payload.clientId,
          });
        }
        return removed;
      }

      case "presence-heartbeat": {
        // A heartbeat carries one node's local clients — upsert them, but
        // don't remove absent peers (they may live on another node).
        let changed = false;
        for (const client of payload.clients) {
          const existing = this.peers.get(client.clientId);
          this.peers.set(client.clientId, {
            awarenessId: client.awarenessId,
            clientId: client.clientId,
            userId: client.userId,
            data: client.data,
            document: message.document,
            joinedAt: existing?.joinedAt ?? now,
            lastSeen: now,
          });
          if (!existing) {
            changed = true;
            this.pushFeed({
              timestamp: now,
              kind: "join",
              userId: client.userId,
              clientId: client.clientId,
            });
          }
        }
        return changed || payload.clients.length > 0;
      }

      default:
        // presence-announce carries only our own awarenessId
        return false;
    }
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
