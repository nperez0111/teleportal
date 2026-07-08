# Transports

The `transports` module is Teleportal's composable message-plumbing layer. It
defines a small, uniform interface — a **Source** to read from and a **Sink** to
write to — and a set of functions that implement that interface over concrete
protocols (HTTP, SSE, Redis/NATS pub-sub, Y.Doc) and that wrap other transports
to add behaviour (encryption, rate limiting, validation, acknowledgements,
logging).

Everything above the transport layer (providers, the server) speaks only in
`Source`/`Sink`/`Transport`, so swapping protocols or inserting middleware never
touches sync logic.

## Why it exists

A sync server has to move CRDT messages between many endpoints — browser tabs
over HTTP/SSE, other server instances over a message bus, an in-process Y.Doc —
and it has to do cross-cutting things to those messages (authorize them, rate
limit them, encrypt them, acknowledge them). Rather than bake each concern into
each protocol, transports factor the two axes apart:

- **Protocol transports** know how bytes get from A to B.
- **Middleware transports** wrap any transport to add one concern, and compose.

## Core model

```ts
type Source<Context, Extra> = { source: AsyncIterable<Message<Context>[]> } & Extra;
type Sink<Context, Extra> = {
  write(m: Message<Context>): void | Promise<void>;
  close(): void;
} & Extra;
type Transport<Context, Extra> = Source<Context, Extra> & Sink<Context, Extra>;
```

Key facts that drive every implementation:

- **A Source yields _batches_** (`AsyncIterable<Message[]>`), not single
  messages. Producers accumulate whatever arrived between pulls and hand it over
  as one array. This is what makes size/time batching and lazy compaction
  (dedup awareness, merge doc updates) cheap.
- **A Source is single-consumer.** The underlying `Channel` throws if iterated
  twice — fan-out is an explicit opt-in (`createFanOutWriter`).
- **`write` may be sync or async.** Middleware that needs to await (validation,
  ack tracking) returns a promise; fire-and-forget sinks don't.
- **`BinaryTransport`** is the same shape over raw `BinaryMessage`s instead of
  decoded `Message`s. `toBinaryTransport` / `fromBinaryTransport` convert
  between the two and answer protocol pings inline.

Most transports are built on the `Channel` primitive from
[`../lib/iter`](../lib/iter): a compacting inbox that bridges a push-based API
(`send`/`trySend`) to pull-based async iteration, with optional lazy
`compact` at drain time.

## Import paths

The barrel `teleportal/transports` re-exports **ack, encrypted, http, logger,
message-validator, passthrough, pubSub, sse, ydoc, and utils**. Import all of
those from the barrel:

```ts
import {
  compose,
  connect,
  sync,
  getHTTPSource,
  getHTTPSink,
  getSSESink,
  getSSESource,
  withLogger,
  withMessageValidator,
  withPassthrough,
  getYTransportFromYDoc,
  getEncryptedTransport,
} from "teleportal/transports";
```

The optional-dependency transports have **their own entry points** so their
third-party clients aren't bundled unless used:

```ts
import { withRateLimit, defaultRateLimitRules } from "teleportal/transports/rate-limiter";
import { getRedisTransport, RedisPubSub, RedisRateLimitStorage } from "teleportal/transports/redis";
import { NatsPubSub } from "teleportal/transports/nats";
```

## Utility functions (`utils.ts`)

### Composition & connection

- **`compose(source, sink)`** → `Transport`. Merges the two, but always takes
  `source` from the Source arg and delegates `write`/`close` as method calls to
  the Sink arg (so passing a Transport as the sink can't shadow the wrapped
  source, and class-based sinks keep their `this`).
- **`connect(source, sink)`** — drains a Source (or bare `AsyncIterable<T[]>`)
  into a Sink, one message at a time, awaiting each `write`.
- **`sync(a, b)`** — bidirectional `connect`: A→B and B→A concurrently.
- **`forEachMessage(source, fn)`** — drains a batched source one item at a time,
  awaiting `fn` per item.

### Concurrency

- **`createFanOutWriter<T>()`** — `{ send, close, getReader }`. Each
  `getReader()` returns an independent `{ source, unsubscribe }`; one `send`
  reaches every live reader. Built on the `../lib/iter` broadcast.
- **`createSerialQueue(process)`** — `{ enqueue, close }`. Processes items
  strictly in enqueue order, one at a time; each `enqueue()` resolves only after
  _its_ item finished. A failing item rejects its own `enqueue` but does not
  poison the queue.

### Encoding / conversion

- **`decodeMessages(context)`** — transform `AsyncIterable<BinaryMessage[]>` →
  `AsyncIterable<Message[]>`; `context` may be a value or a function of the raw
  message.
- **`toBinaryTransport` / `fromBinaryTransport`** — convert between decoded and
  binary transports. `fromBinaryTransport` answers pings inline (replies with a
  pong, drops the ping from the decoded stream).
- **`toMessageArrayTransform` / `fromMessageArrayTransform(context)`** — encode a
  batch as a single `MessageArray` and back.

### Batch-preserving transforms

Lift per-item logic to a transform over `AsyncIterable<T[]>`. **None of them ever
yield an empty batch** (a fully-filtered batch is skipped, which keeps consumers
from mistaking "nothing passed" for "stream idle"):

- **`mapMessages(fn)`** — map each item to one output; return `null`/`undefined`
  to drop it. `fn` may be async.
- **`filterMessages(predicate)`** — keep items passing a (possibly async)
  predicate.
- **`flatMapMessages(fn)`** — expand each item into zero or more outputs.

`batch` (re-exported from `../lib/iter`) does time/size batching and is used by
the HTTP sink.

## Protocol transports

### HTTP (`http/`)

Message transport over discrete HTTP requests.

- **`getHTTPSource({ context })`** → `Source` + `handleHTTPRequest(request)`.
  Single-use: `handleHTTPRequest` reads the POST body as a `MessageArray`,
  decodes it, stamps `context` onto each message, sends them into the channel,
  then **closes** the channel. One request = one drained source.
- **`getHTTPSink({ request, context, batchingOptions })`** → `Sink`. Buffers
  writes through the shared time/size `batch` (`maxBatchSize` default 10,
  `maxBatchDelay` default 100 ms); each flushed batch is `encodeMessageArray`-d
  and handed to your `request` callback as one `POST`
  (`Content-Type: application/octet-stream`, `x-teleportal-client-id` header). A
  failed request drops _that batch only_ and keeps draining.

### SSE (`sse/`)

Server-Sent Events for server→client streaming, with the client's return channel
carried separately (usually via the HTTP sink).

- **`getSSESink({ context })`** → `Sink` + `sseResponse: Response`. Emits the
  `client-id` as the first SSE event, then base64-encoded binary `message`
  events, plus a `ping` keepalive every **5 s**. Frames are emitted as **UTF-8
  bytes** (Cloudflare `workerd` rejects string chunks in a `Response` body). The
  ping interval self-clears once the channel stops accepting frames.
- **`getSSESource({ source: EventSource, context, onPing? })`** → `Source` +
  `{ clientId: Promise<string>, eventSource }`. `clientId` resolves from the
  first `client-id` event. Pings are consumed inline (invoke `onPing`, never
  surface). A **3 s** interval polls `readyState` and closes the channel once the
  `EventSource` is `CLOSED`; the source also `.close()`s the `EventSource` when
  iteration ends.

### PubSub (`pubSub/`)

Backend-agnostic publish/subscribe over any `PubSub` implementation.

- **`getPubSubSource({ getContext, pubSub, sourceId })`** → `Source` +
  `{ subscribe, unsubscribe, pubSub }`. Subscribing to a topic wires its
  messages into the channel; messages whose `sourceId` matches this source are
  dropped to break loops. `subscribe` is idempotent per topic;
  `unsubscribe()` with no argument removes every subscription.
- **`getPubSubSink({ pubSub, topicResolver, sourceId })`** → `Sink`. Publishes
  each write to `topicResolver(message)`. `close()` is a **no-op** — the sink
  owns no per-topic subscriptions; tear down the _source_ (`unsubscribe`) or the
  backing `pubSub` to stop consuming.
- **`getPubSubTransport(...)`** — `compose` of the two.

### Redis (`redis/`) · `teleportal/transports/redis`

- **`RedisPubSub`** — `PubSub` over `ioredis` using **separate publisher and
  subscriber connections**. Topic subscriptions are **reference-counted**: N
  subscribers to a topic share one Redis `SUBSCRIBE`; the Redis `UNSUBSCRIBE`
  only fires when the last local subscriber leaves. Decode failures emit an
  `error` wide event instead of throwing on the connection. Implements
  `Symbol.asyncDispose` (`quit`s both connections).
- **`getRedisTransport(...)`** — a `getPubSubTransport` over a `RedisPubSub`,
  with an async `close()` that disposes the connections.
- **`RedisRateLimitStorage`** — `RateLimitStorage` over Redis hashes, with
  `transaction()` implemented as a Lua-checked distributed lock (SET NX PX +
  compare-and-delete release), retried up to ~1 s. Enables cross-instance rate
  limits.

### NATS (`nats/`) · `teleportal/transports/nats`

- **`NatsPubSub`** — `PubSub` over a lazily-provided `NatsConnection` (you pass a
  `() => Promise<NatsConnection>` factory so the NATS client isn't imported until
  used). Decode failures emit an `error` wide event; `Symbol.asyncDispose`
  drains the connection.

### YDoc (`ydoc/`)

Bridges an in-process `Y.Doc` + `Awareness` into a transport. This is the
building block underneath the encrypted transport and any server-side document
that participates in sync.

- **`getYDocSource(...)`** → `Source` + `{ ydoc, awareness, handler }`. Listens
  for local doc/awareness updates and emits sync messages. Updates originating
  from the sync transaction (`getSyncTransactionOrigin(ydoc)`) are ignored to
  avoid echo loops. On iteration end it detaches every `ydoc`/`awareness`
  listener.
- **`getYDocSink(...)`** → `Sink` + `{ ydoc, awareness, synced }`. Applies
  incoming messages: `sync-step-1` → reply with `sync-step-2`, `sync-step-2` /
  `update` → apply, `sync-done` → resolve `synced`, `auth-message` → throw.
  Messages for other documents, or echoed `local` messages, are ignored. The
  `synced` promise resolves on `sync-done` and **rejects on `close()`** (e.g.
  switching documents mid-sync); an internal no-op `.catch` keeps an unconsumed
  `synced` from surfacing as an unhandled rejection.
- **`getYTransportFromYDoc(...)`** — `compose` of the two, sharing one `ydoc`,
  `awareness`, and `observer`.

Both the default source and sink handlers speak the **content-encrypted
envelope** format (`encodeContentEncryptedPayload`): a structure-only update
plus (here empty) encrypted sidecars. This keeps the on-the-wire and on-disk
format identical whether or not content encryption is in use.

**Update batching** (`updateBatchIntervalMs`, default `0` = off): when > 0, rapid
`Y.Doc` updates are accumulated and merged with `Y.mergeUpdatesV2` before the
handler sees them, trading a little latency for far fewer, larger messages.
Pending updates are flushed on `destroy` before the channel closes.

### Encrypted (`encrypted/`)

End-to-end **content** encryption layered on the YDoc transport. The server
stores structure-only updates (document _shape_ but not text/data) alongside
opaque encrypted **sidecars**; only a client holding the right `CryptoKey` can
restore full content.

- **`getEncryptedTransport(handler, { updateBatchIntervalMs? })`** — wraps an
  `EncryptionClient` as a `Transport` (a YDoc source+sink whose handler is the
  client), exposing `{ ydoc, awareness, synced, handler }`.
- **`EncryptionClient`** — implements both YDoc handler interfaces:
  - `start()` sends `sync-step-1` with the local state vector.
  - `handleSyncStep1()` replies with an encrypted `sync-step-2` (local diff
    stripped into structure + encrypted sidecar).
  - `onUpdate()` / `handleUpdate()` encrypt local edits / decrypt+apply peer
    edits, accumulating sidecars.
  - Awareness updates are encrypted/decrypted transparently.
  - **Sidecar compaction**: once `COMPACTION_THRESHOLD` (25) sidecars
    accumulate, a background task merges them into one; the result piggybacks on
    the next outgoing message via `#takeReadyCompaction`. Only one compaction
    runs at a time.
  - `destroy()` releases the cached tokenizer, pending compaction, and sidecar
    buffer.

## Middleware transports

Each takes a transport (or bare source/sink) and returns the same shape, so they
chain freely. Middleware that only wraps the **source** returns the input
unchanged when its callback is absent (zero overhead).

### Passthrough (`passthrough/`)

The base inspection/interception middleware.

- **`withPassthroughSink(sink, { onWrite? })`** — `onWrite` returning `false`
  blocks the write. `close` is delegated explicitly so class-based sinks keep
  their prototype method.
- **`withPassthroughSource(source, { onRead? })`** — `onRead` returning `false`
  filters the message out.
- **`withPassthrough(transport, { onRead?, onWrite? })`** — both, via `compose`.
- **`noopTransport()`** — an already-closed, do-nothing transport (testing).

### Logger (`logger/`)

- **`withLogger(transport)`** — a `withPassthrough` that `console.info`s every
  read and write. A **development convenience only**; it logs unstructured lines
  and is not intended for production (see the wide-events logging guidance).

### Message Validator (`message-validator/`)

- **`withMessageValidator(transport, { isAuthorized? })`**, plus the
  `...Source` / `...Sink` halves. `isAuthorized(message, type)` gates each
  message; with no `isAuthorized`, everything passes.
- **Both directions check `"write"` permission.** This is deliberate for
  server-side use: the source carries messages _from_ clients (clients writing
  _to_ the server), and the sink carries writes _out_. Checking the source with
  `"read"` would reject legitimate client updates. (Regression-tested in
  `message-validator-fix.test.ts`.)

### Rate Limiter (`rate-limiter/`) · `teleportal/transports/rate-limiter`

Inbound-only token-bucket rate limiting with **flow-control-by-delay**.

- **`withRateLimit(transport, options)`** / **`RateLimitedTransport`** — wrap a
  transport; the inbound `source` is rate limited, the outbound `write` is
  **passed through untouched**.
- **`defaultRateLimitRules()`** — separate budgets: sync (300/s per user,
  1500/10s per document), awareness/presence (120/s per user), file-transfer
  chunks (5000/s per user).
- Helpers: **`isFileTransferMessage`**, **`isEphemeralMetadataMessage`**.

Design decisions baked into the code:

- **Inbound only.** Silently dropping a server-originated doc update permanently
  diverges the receiving client — Y.js parks every causally-later update on the
  missing dependency until a full resync. Egress is already bounded because every
  broadcast originates from a rate-limited ingress message.
- **Hold, don't drop (default).** A limited message is _held_ until its bucket
  refills, up to `maxDelayMs` (default 1000 ms). The per-connection source is
  consumed sequentially, so holding naturally throttles the sender losslessly.
  Only a wait that would exceed the budget drops the message (and fires
  `onRateLimitDrop` so the server can nack). Set `maxDelayMs: 0` for legacy
  drop-only behaviour.
- **Never throw from the source.** A throw would tear down the server's
  per-client consume loop (it stops acking/broadcasting while the socket stays
  open). Dropped messages are nacked, never thrown.
- **Multi-rule with token refunds.** All rules must pass. A message dropped by a
  later rule refunds the tokens it already consumed from earlier rules, so a
  client's retransmit isn't double-charged.
- **`resetAt` = time to the _next token_,** not time to a full window — a nacked
  sender only waits the fractional remainder of one token.
- **Tracking:** `user` / `document` / `user-document` / `transport`. With no
  `RateLimitStorage`, an in-memory per-transport bucket map is the fallback
  (capped at 10 000 entries, oldest-evicted), keyed the same way a storage
  backend would key it — so limits still apply per tracked entity within the
  connection. `maxMessages` / `windowMs` may be functions of the message.

### ACK (`ack/`)

Acknowledgement support over a `PubSub` for reliable delivery.

- **`withAckSink(sink, { pubSub, ackTopic, sourceId, context })`** — after each
  non-ack write, publishes an `AckMessage` (referencing the written message's
  id) to `ackTopic`.
- **`withAckTrackingSink(sink, { pubSub, ackTopic, sourceId, ackTimeout?, abortSignal? })`**
  — tracks each non-ack write and resolves it when a matching ack arrives.
  Returns `waitForAcks()` and `unsubscribe()`.
  - `waitForAcks()` resolves once all currently-tracked messages are acked,
    rejects if any times out (`ackTimeout`, default 10 000 ms).
  - **Settled promises are removed from the pending set** on _either_ outcome
    (resolved or rejected). A timed-out message no longer poisons a later
    `waitForAcks()` and the set can't grow unbounded on a long-lived connection.
  - **`abort` / `unsubscribe` are terminal**: they reject in-flight waits and
    every subsequent `waitForAcks()` (with `"Request aborted"` /
    `"Unsubscribed"`), distinct from a recoverable per-message timeout.

## Composition patterns

### Layered middleware

```ts
import {
  compose,
  getHTTPSource,
  getHTTPSink,
  withLogger,
  withMessageValidator,
} from "teleportal/transports";
import { withRateLimit, defaultRateLimitRules } from "teleportal/transports/rate-limiter";

let transport = compose(getHTTPSource({ context }), getHTTPSink({ request, context }));

// Inbound-only rate limiting (server-side ServerContext transports)
transport = withRateLimit(transport, { rules: defaultRateLimitRules() });

// Authorize both directions with "write" permission
transport = withMessageValidator(transport, {
  isAuthorized: async (message, _type) => canWrite(message),
});

// Dev-only tracing
transport = withLogger(transport);
```

### Y.js document transport

```ts
import { getYTransportFromYDoc } from "teleportal/transports";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";

const ydoc = new Y.Doc();
const transport = getYTransportFromYDoc({
  ydoc,
  awareness: new Awareness(ydoc),
  document: "my-document",
  context: { clientId: "client-1" },
});

await transport.handler.start(); // send sync-step-1
await transport.synced; // resolves on sync-done
```

### Encrypted transport

```ts
import { getEncryptedTransport, EncryptionClient } from "teleportal/transports";

const client = new EncryptionClient({ document: "my-doc", key /* CryptoKey */ });
const transport = getEncryptedTransport(client);

await transport.handler.start(); // encrypted sync handshake
```

### Redis pub-sub transport

```ts
import { getRedisTransport } from "teleportal/transports/redis";

const transport = getRedisTransport({
  getContext: { serverId: "server-1" },
  redisOptions: { path: "redis://localhost:6379" },
  sourceId: "server-1",
  topicResolver: (message) => `document/${message.document}`,
});

await transport.subscribe("document/my-doc");
await transport.close(); // closes and disposes the Redis connections
```

### ACK-based reliable delivery

```ts
import { withAckSink, withAckTrackingSink } from "teleportal/transports";

// Server side: emit acks
const ackSink = withAckSink(sink, { pubSub, ackTopic: "acks", sourceId: "server-1", context });

// Client side: await acks
const tracking = withAckTrackingSink(sink, {
  pubSub,
  ackTopic: "acks",
  sourceId: "client-1",
  ackTimeout: 10_000,
});
await tracking.write(message);
await tracking.waitForAcks();
```

### Fan-out broadcasting

```ts
import { createFanOutWriter } from "teleportal/transports";

const fanOut = createFanOutWriter<Message>();
const a = fanOut.getReader();
const b = fanOut.getReader();
fanOut.send(message); // both a.source and b.source receive it
```

## File transfer

File transfer lives at the Provider level as RPC handlers, not in transports.
See the [File Protocol docs](../protocols/file/README.md). The rate limiter still
recognizes file chunks (`isFileTransferMessage`) so they get their own budget.

## See also

- [Protocol](../lib/protocol/README.md) — message format and encoding
- [Encryption protocol](../lib/protocol/encryption/README.md) — sidecars & envelopes
- [Providers](../providers/README.md) — high-level client/connection API
- [Storage](../storage/README.md) — persistence and `RateLimitStorage`
- [`../lib/iter`](../lib/iter) — `Channel`, `batch`, broadcast primitives
  </content>
