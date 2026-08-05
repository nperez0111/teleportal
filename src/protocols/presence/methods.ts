import { defineMethod, definePush, defineProtocol } from "teleportal/rpc";

/**
 * One present peer: an announced awareness clientID with the connection,
 * user, and integrator-projected data it belongs to.
 *
 * Presence is always cleartext (it carries no document content): the numeric
 * awareness `clientID` must be readable by the server even for end-to-end
 * encrypted documents — it is what makes server-driven awareness clearing work.
 */
export type PresenceEntry = {
  awarenessId: number;
  clientId: string;
  userId: string;
  data: Record<string, unknown>;
};

export type PresenceAnnounceRequest = {
  awarenessId: number;
  /**
   * Announces are content-hashed for ack correlation; a client re-announcing
   * the same awarenessId in quick succession (rapid reconnects) would produce
   * byte-identical requests whose pending-request entries collide. The nonce
   * keeps each announce unique.
   */
  nonce?: number;
};

export type PresenceRosterPayload = {
  clients: PresenceEntry[];
};

/**
 * The presence protocol: who is in a document right now.
 *
 * - `announce`/`unannounce` — client→server request/response, sent on connect
 *   (after the doc handshake) and on provider destroy.
 * - `join`/`leave` — server-authored pushes fanned out to peers (and other
 *   nodes over pub/sub, consumed into their cross-node roster).
 * - `roster` — a full snapshot. Node→node it carries one node's local clients
 *   (reconciled against the last-known snapshot, TTL-refreshing the node);
 *   server→client it carries the combined roster clients reconcile against,
 *   self-healing any lost join/leave within one heartbeat interval.
 *   `dedupe: false` is load-bearing: identical periodic snapshots hash to
 *   identical message ids and would otherwise be dropped as replication
 *   duplicates after the first heartbeat.
 * - `rosterRequest` — node→node pull: "everyone, publish your roster now".
 *   Sent when a session opens (a fresh node would otherwise wait up to a full
 *   heartbeat interval with an empty cross-node roster) and on a replication
 *   gap. Rosters stay ephemeral on purpose — they are *state*, not events, so
 *   replaying old snapshots from a durable log would resurrect ghosts; a pull
 *   always yields current state. `dedupe: false` because the payload is empty:
 *   requests from different nodes (or the same node twice) are byte-identical.
 */
export const presenceProtocol = defineProtocol("presence", {
  announce: defineMethod<"presenceAnnounce", PresenceAnnounceRequest, Record<string, never>>(
    "presenceAnnounce",
  ),
  unannounce: defineMethod<"presenceUnannounce", PresenceAnnounceRequest, Record<string, never>>(
    "presenceUnannounce",
  ),
  // dedupe: false on join/leave too: an announce → unannounce → re-announce
  // with unchanged data produces a byte-identical presenceJoin, which the
  // 30s replication dedup window would swallow — remote users would not see
  // the peer again until the next heartbeat. Handlers are idempotent
  // upserts/removes, so genuine duplicate deliveries are harmless.
  join: definePush<"presenceJoin", PresenceEntry>("presenceJoin", {
    qos: { dedupe: false },
  }),
  leave: definePush<"presenceLeave", PresenceEntry>("presenceLeave", {
    qos: { dedupe: false },
  }),
  roster: definePush<"presenceRoster", PresenceRosterPayload>("presenceRoster", {
    qos: { dedupe: false },
  }),
  rosterRequest: definePush<"presenceRosterRequest", Record<string, never>>(
    "presenceRosterRequest",
    { qos: { dedupe: false } },
  ),
});
