# Presence Protocol

Who is in a document right now: announced awareness clientIDs with the connection, user, and integrator-projected data they belong to. Built entirely on RPC requests and pushes — presence is **not** a native wire message type, and the server core contains no presence logic.

## Overview

Each client announces its awareness clientID after connecting; the server maintains the roster (local clients plus clients on other nodes), broadcasts join/leave pushes to peers, and periodically pushes full roster snapshots so any lost push self-heals. The client extension maintains `provider.peers` and clears the awareness states of departed peers.

Presence is always **cleartext** (it carries no document content): the numeric awareness `clientID` must be readable by the server even for end-to-end encrypted documents — it is what makes server-driven awareness clearing work.

## File Structure

```
src/protocols/presence/
  methods.ts   — method contracts (defineMethod/definePush/defineProtocol) + payload types
  server.ts    — server handlers (createHandlers) + roster state + maintenance tick
  client.ts    — client extension (roster, reconcile, offline clearing)
  index.ts     — public exports
```

## Contract

| Wire name               | Kind             | Direction                | Payload                          | QoS                                 |
| ----------------------- | ---------------- | ------------------------ | -------------------------------- | ----------------------------------- |
| `presenceAnnounce`      | request-response | client → server          | `{ awarenessId, nonce? }` → `{}` | —                                   |
| `presenceUnannounce`    | request-response | client → server          | `{ awarenessId, nonce? }` → `{}` | —                                   |
| `presenceJoin`          | push             | server → clients + nodes | `PresenceEntry`                  | push defaults + **`dedupe: false`** |
| `presenceLeave`         | push             | server → clients + nodes | `PresenceEntry`                  | push defaults + **`dedupe: false`** |
| `presenceRoster`        | push             | server → clients + nodes | `{ clients: PresenceEntry[] }`   | push defaults + **`dedupe: false`** |
| `presenceRosterRequest` | push             | node → nodes             | `{}`                             | push defaults + **`dedupe: false`** |

`PresenceEntry` is `{ awarenessId, clientId, userId, data }`. The announce `nonce` keeps
byte-identical re-announces (rapid reconnects) from colliding in ack correlation.

`dedupe: false` on every push is load-bearing: presence messages are content-hash
identified, and byte-identical repeats are _legitimate_ — identical periodic roster
snapshots, an announce → unannounce → re-announce of the same entry within the 30s dedup
window (the re-join would silently vanish cluster-wide), and roster requests, whose empty
payload makes any two requests identical. Handlers are idempotent upserts/removes, so
genuine duplicate deliveries are harmless.

`presenceRosterRequest` is the pull side of the roster exchange: a node publishes it when
a session opens (a fresh node would otherwise wait up to a full heartbeat interval with an
empty cross-node roster) and on a `replication-gap` event, publishing its own snapshot
alongside; every node answers by publishing its local roster, so the whole network
refreshes symmetrically. Rosters stay **ephemeral by design** — they are state, not
events: replaying old snapshots from a durable log would resurrect ghost peers, while a
pull always yields current state. Both sides are throttled by
`rosterRefreshMinIntervalMs` (default 1s): refreshes coalesce and request storms are
answered once per window, so a backend that fires gap events for every topic at once
(e.g. a NATS stream purge) cannot trigger a cluster-wide roster exchange per document per
gap.

**Ownership moves, it doesn't die**: an awarenessId is bound to one Y.Doc, but its
connection can change — a reconnect to the same node transfers the entry silently, and a
reconnect to _another_ node is handled by leave suppression: a leave (from a dying
connection, a replicated push, snapshot reconciliation, or node TTL expiry) is only
forwarded when the awarenessId is not represented by any other source (a local client or
another node). Without this, the stale connection's death would clobber the live peer and
destroy its awareness state on every client. The combined roster deduplicates by
awarenessId with local entries winning.

Server-authored pushes are not forgeable: a client-authored `presenceJoin`/`presenceLeave`/
`presenceRoster`/`presenceRosterRequest` push is dropped (`forwardToLocalClients: false`,
`replicate: false`), not applied — and the RPC layer additionally never replicates
client-authored pushes unless a handler explicitly vouches for them.

## Server Usage

The protocol is **registered by default** by the `Server`; configure it via the `presence`
option, or pass `presence: false` to opt out (e.g. to register your own implementation via
`rpcHandlers` — user-supplied handlers win on name collisions anyway):

```typescript
import { Server } from "teleportal/server";

const server = new Server({
  storage: async () => documentStorage,
  presence: {
    // Project a client's context into the `data` bag shared with peers.
    getPresenceData: async (context) => ({ name: await lookupName(context.userId) }),
    heartbeatIntervalMs: 30_000, // roster heartbeat cadence (0 disables the timer)
    presenceTtlMs: 90_000, // how long a remote node is trusted without a heartbeat
    rosterRefreshMinIntervalMs: 1_000, // storm brake for roster requests/answers (0 disables)
  },
});

// Opt out / swap the implementation:
import { getPresenceRpcHandlers } from "teleportal/protocols/presence";

const custom = new Server({
  storage: async () => documentStorage,
  presence: false,
  rpcHandlers: {
    ...getPresenceRpcHandlers({ getPresenceData }),
  },
});
```

Per-session roster state lives inside the protocol (a WeakMap keyed by `Session`), wired up
via the server's `session-open` event and torn down on the session's `dispose`. The session's
`client-leave` event (fired on disconnect, including by the core liveness sweep) is what
broadcasts leaves for a departed client's awareness entries.

Create **one registry per `Server`**: the registry's `init` teardown clears the timers and
listeners of every session it tracks, so a registry shared between two servers would tear
down the other server's presence maintenance when either disposes.

`runPresenceMaintenance(registry, session)` drives one maintenance tick deterministically
(for tests, with `heartbeatIntervalMs: 0`).

## Client Usage

The provider **auto-registers** the extension under `rpc.presence` (a user-supplied
`"presence"` key in the `rpc` map wins); `provider.peers` and the `peer-join`/`peer-leave`
events delegate to it:

```typescript
const provider = await Provider.create({
  url: "wss://...",
  document: "my-doc",
  encryptionKey,
  offlineTimeoutMs: 30_000, // clear peers/remote awareness after this long offline
  presenceJoinGraceMs: 5_000, // roster-reconcile join-protection window
});

provider.on("peer-join", (peer) => console.log("joined", peer.awarenessId, peer.data));
provider.on("peer-leave", (peer) => console.log("left", peer.awarenessId));
provider.peers; // ReadonlyMap<number, PresenceEvent> keyed by awareness clientID
```

`createPresenceExtension(options)` is the underlying factory if you need to register it
manually (e.g. with custom options per document).

## Lifecycle

**Client side:**

- **Announce on connect**: the extension's `onConnect` hook announces this provider's
  awareness clientID on every (re)connect, after the doc sync handshake (fire-and-forget —
  a lost announce is healed by the next reconnect or the server's roster push). `destroy`
  sends a best-effort `presenceUnannounce`.
- **Roster reconcile**: join/leave pushes maintain `peers` incrementally; the server's
  periodic `presenceRoster` snapshot is the full truth the client reconciles against, so a
  missed push heals within one heartbeat. A peer that joined within `presenceJoinGraceMs`
  is spared from removal by a stale snapshot.
- **Offline honesty**: after `offlineTimeoutMs` without a connection, all remote presence
  and awareness states are cleared (with `peer-leave` per peer) — an offline provider
  reports no peers rather than a stale roster.

**Server side:**

- **Announce** records the entry, notifies already-announced local peers (`presenceJoin`),
  publishes the join to other nodes, and replies to the announcer with a full combined
  roster snapshot (local + cross-node).
- **Heartbeat/TTL cross-node reconciliation**: every `heartbeatIntervalMs`, each node
  publishes a snapshot of its own local clients over the document pub/sub topic (node →
  node) and pushes the combined roster to its local clients. Receiving nodes reconcile a
  remote snapshot against what they last knew (emitting local join/leave pushes for the
  diff) and TTL-expire nodes whose heartbeats stop (`presenceTtlMs`), clearing their
  clients — self-healing across node crashes.
- **Liveness stays in core**: the transport-level ping sweep
  (`ServerOptions.livenessConfig.clientTtlMs`) is a socket concern in the server core; the
  presence protocol only consumes the resulting `client-leave` event to broadcast leaves.
  Because the awareness clientID travels in cleartext, this works for E2E-encrypted
  documents too.

## See Also

- [`teleportal/rpc`](../../lib/rpc/README.md) — RPC framework primitives (`definePush`, QoS, `pushHandler`)
- [`teleportal/providers`](../../providers/README.md) — Provider roster mechanics (`provider.peers`)
- [`teleportal/server`](../../server/README.md) — Session push primitives and `livenessConfig`
