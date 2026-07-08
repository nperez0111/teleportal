# Rate Limiter transport

Import path: `teleportal/transports/rate-limiter`

Wraps a `Transport` and rate limits its **inbound** message stream with a token
bucket per rule, using **flow-control-by-delay**: a limited message is held
until its bucket refills rather than dropped, so a fast sender is throttled
losslessly. Outbound writes are never touched.

```ts
import { withRateLimit, defaultRateLimitRules } from "teleportal/transports/rate-limiter";

const limited = withRateLimit(transport, {
  rules: defaultRateLimitRules(),
  // maxDelayMs: 1000,      // hold budget before a message is dropped+nacked
  // rateLimitStorage,      // omit for in-memory per-transport buckets
  onRateLimitDrop: (msg, exceeded, write) => write(nack(msg, exceeded)),
});
```

## Why inbound-only

Silently dropping a **server→client** doc update permanently diverges the
receiving client: Y.js parks every causally-later update on the missing
dependency until a full state-vector resync. So `write` is a pure passthrough.
Egress volume is already bounded because every broadcast originates from a
rate-limited inbound message.

## Why hold instead of drop

The per-connection source is consumed sequentially. Holding a message until the
next token refills (bounded by `maxDelayMs`, default 1000 ms) slows the sender to
the allowed rate while delivering everything in order. Dropping instead would
engage the client's NACK/retransmit path, and the retransmit races the client's
fresh sends for every refilled token while all causally-later updates are parked
— peers see nothing until the client stops typing. Set `maxDelayMs: 0` for
legacy drop-immediately behaviour.

Only a wait that would exceed `maxDelayMs` drops the message. Drops **never
throw** (a throw tears down the server's consume loop); instead `onRateLimitDrop`
fires so the caller can nack the sender.

## Rules

Every rule in `rules` must pass. Each rule:

| field                           | meaning                                                        |
| ------------------------------- | -------------------------------------------------------------- |
| `id`                            | unique; used in keys, metrics, events                          |
| `maxMessages`                   | tokens per window — number or `(msg) => number`                |
| `windowMs`                      | window length — number or `(msg) => number`                    |
| `trackBy`                       | `"user"` \| `"document"` \| `"user-document"` \| `"transport"` |
| `rateLimitStorage?`             | per-rule storage override                                      |
| `getUserId?` / `getDocumentId?` | per-rule key extractors                                        |
| `shouldSkipRule?`               | skip this rule (consumes no token) for some messages           |

**Token refunds:** a message dropped by a later rule refunds the tokens it
already consumed from earlier rules, so a retransmit isn't double-charged.

**`resetAt`** reported to observers is the time until the _next single token_ (a
fraction of a window), not time until a full bucket — a nacked sender waits only
that fraction.

## Storage & tracking

With a `RateLimitStorage` (e.g. `RedisRateLimitStorage`) rate limits are shared
across instances via `transaction()`. Without one, an **in-memory
per-transport** bucket map is the fallback — capped at 10 000 entries
(oldest-evicted, and evicted entries resurrect full), keyed exactly as a storage
backend would key them, so `user`/`document`/`user-document` rules still apply
per tracked entity within that connection instead of silently not at all.

## Default rules (`defaultRateLimitRules`)

Separate budgets so one traffic class can't starve another:

- **sync** — 300 msgs/s per user, 1500 msgs/10 s per document (skips awareness &
  file chunks)
- **awareness/presence** — 120 msgs/s per user (ephemeral: dropping one is
  harmless, never retransmitted, so it can't drain the sync budget)
- **file transfer** — 5000 chunks/s per user

File _initiation_ requests (non-stream RPC) count toward the sync budget.

## Observability

`onRateLimitExceeded`, `onRateLimitDelay` (held-then-delivered — the healthy
signal), `onMessageSizeExceeded`, `onPermissionDenied`, plus a `metricsCollector`
and `eventEmitter`. Oversized inbound messages (`maxMessageSize`, default 10 MB)
are nacked with an `AckMessage` error and dropped without killing the stream.
</content>
