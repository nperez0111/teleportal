# Teleportal Core Library (`src/lib/`)

The core, runtime-agnostic building blocks of Teleportal: the binary wire
protocol, content-level encryption, the attribution data model, the RPC
authoring framework, and async-iterator plumbing. Everything here is pure
TypeScript over standard JS + `lib0` + `yjs` — no transport, storage, or
runtime coupling.

## Directory Structure

| Module                                                    | Description                                                                                                             |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| [`protocol/`](./protocol/README.md)                       | Binary wire format: encode/decode of all message types, Y.js update utils, milestone & pub/sub serialization, ping/pong |
| [`protocol/encryption/`](./protocol/encryption/README.md) | Content-level (E2EE) encryption for Y.js updates — strip/restore, sidecars, wire payload                                |
| [`attribution/`](./attribution/README.md)                 | Attribution (authorship) data model: ID sets, content maps, set operations, binary encoding, queries                    |
| [`rpc/`](./rpc/README.md)                                 | Type-safe RPC authoring framework (`defineMethod`, `createHandlers`, `createClientExtension`)                           |
| [`iter/`](./iter/README.md)                               | Async-iterator primitives: channels, broadcast, batching, stream adapters                                               |
| `index.ts`                                                | Core type aliases (`Source`, `Sink`, `Transport`, `BinaryTransport`, `PubSub`, contexts)                                |
| `utils.ts`                                                | `Observable` event emitter (over `hookable`) and `InMemoryPubSub`                                                       |

Each sub-directory has its own README with the authoritative, code-accurate
detail for that concern. This document only summarizes the wire protocol at a
glance; **[`protocol/README.md`](./protocol/README.md) is the source of truth**
for the exact byte layout.

---

## Wire protocol at a glance

Every framed message (version 1) begins with a fixed header:

```
[0x59 0x4a 0x53]   magic "YJS" (3 bytes)
[0x01]             version (1 byte)
[varString]        document name (empty string for ack messages)
[uint8]            encrypted flag (0 or 1)
[uint8]            message type
```

### Message types

| Type byte | Name        | Meaning                                                           |
| --------- | ----------- | ----------------------------------------------------------------- |
| `0x00`    | `doc`       | Y.js sync/update (sync-step-1/2, update, sync-done, auth-message) |
| `0x01`    | `awareness` | Awareness update / request                                        |
| `0x02`    | `ack`       | Acknowledgement or NACK (retry-after or permanent error)          |
| `0x03`    | `presence`  | Client join/leave/announce/unannounce/heartbeat                   |
| `0x04`    | `rpc`       | Remote procedure call (request / stream / response)               |

> **Note:** file transfer and milestone operations are **not** distinct message
> types — they are RPC protocols carried inside `0x04`. See
> [`teleportal/protocols/file`](../protocols/file/README.md) and
> [`teleportal/protocols/milestone`](../protocols/milestone/README.md).

### Doc sub-types (`0x00`)

| Sub-type | Name         | Payload                                    |
| -------- | ------------ | ------------------------------------------ |
| `0x00`   | sync-step-1  | `[varUint8Array: stateVector]`             |
| `0x01`   | sync-step-2  | `[uint8: version] [varUint8Array: update]` |
| `0x02`   | update       | `[uint8: version] [varUint8Array: update]` |
| `0x03`   | sync-done    | (no payload)                               |
| `0x04`   | auth-message | `[uint8: permission] [varString: reason]`  |

Update/sync-step-2 payloads carry a 1-byte version (`1` = V1, `2` = V2) so the
receiver knows which Y.js decoder to use.

### Awareness sub-types (`0x01`)

| Sub-type | Name              | Payload                   |
| -------- | ----------------- | ------------------------- |
| `0x00`   | awareness-update  | `[varUint8Array: update]` |
| `0x01`   | awareness-request | (no payload)              |

### Ack (`0x02`)

```
[varString: messageId]
[uint8: flags]          bit 0 = has retryAfter, bit 1 = has error
[varUint: retryAfter]?  present iff bit 0 set  (retryable NACK, ms)
[varString: error]?     present iff bit 1 set  (permanent NACK reason)
```

An ack with no flags is a plain acknowledgement. `retryAfter` and `error` are
mutually exclusive and signal retryable vs. permanent rejection. Ack messages
carry **no** document name (`document` is `undefined`).

### Presence (`0x03`) and RPC (`0x04`)

See [`protocol/README.md`](./protocol/README.md#presence-sub-types-type-0x03)
for the presence sub-types and RPC framing (method name, request type,
optional `originalRequestId`, success/error payloads, and custom codecs).

## Message IDs

Every `CustomMessage` exposes a lazily-computed, cached `id` (see
`message-types.ts`). It is a **64-bit FNV-1a-style hash of the encoded bytes**,
rendered as 16 lowercase hex characters (two 32-bit halves). It is **not** a
SHA-256 nor base64 — it is a fast, deterministic content fingerprint used for
deduplication, ack correlation, and idempotency. `valueOf()` returns this id, so
messages compare/serialize by identity.

## Ping / Pong

Heartbeats use a distinct 7-byte format (magic + ASCII `"ping"`/`"pong"`), not
the standard header — see [`protocol/README.md`](./protocol/README.md#pingpong).
Because they share the 3-byte magic, `isBinaryMessage()` (magic-only) returns
true for them; use `isPingMessage()` / `isPongMessage()` to discriminate before
treating bytes as a framed message.

## Multi-message batching

Multiple framed messages can be concatenated into a single `MessageArray`, each
length-prefixed as a `varUint8Array`; the decoder reads until the buffer is
exhausted (no explicit count). Used to reduce transport overhead when flushing
several updates at once.

## Core types (`index.ts`)

- **`Source` / `Sink` / `Transport`** — the decoded-message plumbing interfaces.
  A `Source` exposes `source: AsyncIterable<Message[]>`; a `Sink` has
  `write(message)` + `close()`; a `Transport` is both.
- **`BinaryTransport`** — the same shape over raw `BinaryMessage` bytes.
- **`PubSub`** — pluggable publish/subscribe backend (topics `document/*`,
  `client/*`, `ack/*`); `utils.ts` ships an `InMemoryPubSub` for
  testing/development.
- **`ClientContext` / `ServerContext`** — the identity/room context threaded
  through messages.

## Usage examples

```ts
import {
  DocMessage,
  decodeMessage,
  encodeMessageArray,
  decodeMessageArray,
} from "teleportal/protocol";

// Encode a document update
const msg = new DocMessage("my-doc", {
  type: "update",
  update: { version: 2, data: v2Update },
});
const bytes = msg.encoded; // cached BinaryMessage

// Decode a received frame (untrusted until access-checked)
const decoded = decodeMessage(bytes);
if (decoded.type === "doc") {
  // decoded.document, decoded.payload.type, ...
}

// Batch several messages into one frame
const batched = encodeMessageArray([msg, awarenessMsg]);
const back = decodeMessageArray(batched);
```

For RPC, encryption, attribution, and iterator usage, see the respective
sub-directory READMEs.
