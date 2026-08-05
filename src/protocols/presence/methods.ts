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
 * - `rosterRequest` — node→node pull: "everyone, publish your roster now".
 *   Sent when a session opens (a fresh node would otherwise wait up to a full
 *   heartbeat interval with an empty cross-node roster) and on a replication
 *   gap. Rosters stay ephemeral on purpose — they are *state*, not events, so
 *   replaying old snapshots from a durable log would resurrect ghosts; a pull
 *   always yields current state.
 *
 * Every method here repeats itself by design — periodic roster snapshots, empty
 * roster pulls, an announce → unannounce → re-announce cycle with unchanged
 * data. Each of those is a distinct event that happens to carry a payload
 * identical to the last one, and each is safe to dedup because every authored
 * `RpcMessage` carries its own nonce (so only true redeliveries collide).
 */
export const presenceProtocol = defineProtocol("presence", {
  announce: defineMethod<PresenceAnnounceRequest, Record<string, never>>(),
  unannounce: defineMethod<PresenceAnnounceRequest, Record<string, never>>(),
  join: definePush<PresenceEntry>(),
  leave: definePush<PresenceEntry>(),
  roster: definePush<PresenceRosterPayload>(),
  rosterRequest: definePush<Record<string, never>>(),
});
