# 001 — QoS-driven message coalescing

**Status:** decided against, for now (2026-08-05)

Internal design note, not published docs. `docs/decisions/` sits outside the Starlight
content root (`docs/src/content/docs/`) so nothing here is part of the site.

## The question

Transports carry `AsyncIterable<T[]>`. Is that the right abstraction, or should there be a
QoS system where messages known to be non-durable — awareness being the obvious case — are
treated as last-write-wins, so that a batch not yet consumed can be collapsed and a
transmission saved?

The concern raised alongside it was that this adds complexity across the system for a saving
that may be worth very little.

## What the code actually does today

Four findings, in the order that matters.

**1. The hook already exists and nothing uses it.** `ChannelOptions.compact`
(`src/lib/iter/channel.ts:24`) is a lazy drain-time coalesce function, applied to the whole
buffer at the moment a consumer pulls — precisely the "collapse what hasn't been consumed
yet" mechanism. It is documented ("e.g. dedup awareness, merge doc updates"), covered by
tests in `channel.test.ts`, and **passed by zero production call sites**: all 21 `createChannel`
calls outside tests pass no options at all.

So the abstraction is not the obstacle. Someone anticipated this exact idea and left the
seam open.

**2. No consumer ever sees a batch.** `forEachMessage` (`src/transports/utils.ts:142`)
flattens each batch and awaits per item, and it is what every terminal consumer uses:
the server's ingress loop (`src/server/server.ts:950`), the client's outbound drain and its
inbound apply queue (`src/providers/provider.ts:314`, `:330`). Batch structure survives only
as far as transport-level grouping — one HTTP POST body, one `MessageArray` frame. Nothing
downstream can act on a batch, so any coalescing has to happen _at_ the channel, which is
what `compact` is for.

**3. Server-side there is nothing buffered to coalesce.** `Session.broadcast`
(`src/server/session.ts`) is a sequential `for` loop doing `await client.send(message)` per
client. There is no per-client outbound queue anywhere. The saving being imagined — "a batch
sitting unconsumed that we can collapse" — requires a queue to exist first. Building
per-client outbound queues is the real cost of this feature; the coalescing on top is the
cheap part. That inverts the premise of the question.

**4. Most of the value is already banked, by other means.** Awareness is
`requiresAck: false` and `durability: "ephemeral"` (`src/lib/protocol/message-types.ts`), so
it is never acked, never retransmitted, rides the non-persistent pub/sub lane, and is
droppable under pressure. It gets its own rate-limit budget via `isEphemeralMetadataMessage`
(`src/transports/rate-limiter/index.ts`), keyed off exactly that ack policy, specifically so
cursor chatter cannot starve document updates. Doc updates already merge in the client
connection's `#pendingUpdates` and optionally in the Y.Doc source's `updateBatchIntervalMs`.
Cursor movement is already throttled leading+trailing in `src/cursors/throttle.ts`.

The messages a coalescing QoS would target are the ones the system has already made cheap.

## Decision

Do not build it. `AsyncIterable<T[]>` stays.

The reasoning is not "the abstraction is wrong" — it is that the expensive prerequisite
(per-client outbound queues) buys the least valuable saving (dropping a superseded awareness
frame that already costs no ack, no retransmit, no durable storage, and no sync budget).

## What would change the verdict

A measurement, not an argument. Specifically: evidence that awareness or presence egress is
a material share of bytes on the wire or of server event-loop time under realistic
multi-client load. The instrumentation to answer that already exists from the
server-event-loop-freeze investigation.

If it flips, the work has a natural order:

1. Add per-client outbound queues in `Session.broadcast` — the actual prerequisite.
2. Add a coalescing key to `RpcMethodQos` (which today has only `durability`, `replicate`,
   `ack`, `dedupe`) and a way to declare QoS for native `awareness` messages, which currently
   have none — their policy is hardcoded in `AwarenessMessage`'s getters.
3. Pass a `compact` derived from that QoS to the channels that are genuinely buffered: the
   client outbound channel and the pub/sub source channel. Both are real `Channel`s and
   already accept it.

Note that step 3 — the part the original question was about — is a one-line change per call
site. Steps 1 and 2 are the project.
