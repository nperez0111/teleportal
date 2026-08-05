# Protocol

Binary wire format for the Teleportal sync protocol. Handles encoding/decoding of all message types between clients and the server, plus Y.js update utilities, milestone serialization, and file transfer orchestration.

## Wire format (version 2)

Every message starts with a fixed header:

```
[0x59] [0x4a] [0x53]          3 bytes: magic "YJS"
[0x02]                         1 byte:  version
[varString]                    document name (empty for ack messages)
[uint8]                        encrypted flag (0 or 1)
[uint8]                        best-effort flag (1 = receivers must not ack; senders do not retransmit)
[uint8]                        message type
```

Message types:

| Type byte | Name        | Description                                                        |
| --------- | ----------- | ------------------------------------------------------------------ |
| 0x00      | `doc`       | Y.js sync/update messages (sync-step-1/2, update, sync-done, auth) |
| 0x01      | `awareness` | Y.js awareness updates and requests                                |
| 0x02      | `ack`       | Acknowledgement / NACK with optional retry-after or error          |
| 0x04      | `rpc`       | Remote procedure calls with request/stream/response patterns       |

Type 0x03 (`presence`) was deleted: presence is no longer a native wire type
but an RPC protocol module (`teleportal/protocols/presence`).

### Doc sub-types (type 0x00)

| Sub-type | Name         | Payload                                    |
| -------- | ------------ | ------------------------------------------ |
| 0x00     | sync-step-1  | `[varUint8Array: stateVector]`             |
| 0x01     | sync-step-2  | `[uint8: version] [varUint8Array: update]` |
| 0x02     | update       | `[uint8: version] [varUint8Array: update]` |
| 0x03     | sync-done    | (no payload)                               |
| 0x04     | auth-message | `[uint8: permission] [varString: reason]`  |

Updates carry a version byte (1 = V1, 2 = V2) so the receiver knows how to apply them.

### Awareness sub-types (type 0x01)

| Sub-type | Name              | Payload                   |
| -------- | ----------------- | ------------------------- |
| 0x00     | awareness-update  | `[varUint8Array: update]` |
| 0x01     | awareness-request | (no payload)              |

### Ack message (type 0x02)

```
[varString: messageId]
[uint8: flags]               bit 0 = has retryAfter, bit 1 = has error
[varUint: retryAfter]?       present if bit 0 set
[varString: error]?          present if bit 1 set
```

### RPC message (type 0x04)

```
[varString: method]
[uint8: requestType]              0=request, 1=stream, 2=response
[uint8: hasOriginalRequestId]?    present for stream/response only
[varString: originalRequestId]?   present if the flag byte is 1
[uint8: isError]                  0=success, 1=error
```

A "response" with no `originalRequestId` (flag byte 0) is a **push**: an
unsolicited notification authored by the server (or replicated from another
node), correlated to no request. See `definePush` in `teleportal/rpc`.

Success payload: `[varUint8Array: serialized payload]`
Error payload: `[varUint: statusCode] [varString: details] [uint8: hasPayload] [any: payload]?`

Custom serializer/deserializer callbacks can override the default `writeAny`/`readAny` encoding for RPC payloads.

## Message identity

Every decoded message (`DocMessage`, `AwarenessMessage`, `AckMessage`,
`RpcMessage`) extends `CustomMessage`, which exposes:

- **`encoded`** — the `BinaryMessage`, encoded lazily on first access and cached.
- **`id`** — a lazily-computed, cached 64-bit **FNV-1a-style hash of the encoded
  bytes**, rendered as 16 lowercase hex characters. This is a fast content
  fingerprint (not SHA-256, not base64) used for dedup, ack correlation, and
  idempotency. `valueOf()` returns `id`.
- **`resetEncoded()`** — clears the cached `encoded`/`id` after mutating a
  message in place.
- **`durability`** — `"durable" | "ephemeral"`, driving whether a durable
  [`PubSub`](../../transports/README.md) backend persists the message (and replays
  it after a reconnect) or routes it over a non-persistent channel. Default
  `"durable"` (safe for unknown/future types). `DocMessage` is durable for
  `update`/`sync-step-2` and ephemeral for the sync handshake
  (`sync-step-1`/`sync-done`/`auth-message`); `Awareness`/`Ack` are
  ephemeral; `Rpc` defaults to durable but takes a per-message override, stamped
  by the sender from the method's declared QoS (see `definePush` in
  `teleportal/rpc`). Server-authored RPC pushes fan out over pub/sub when their
  method declares `replicate`; client-authored pushes never do unless a
  registered `pushHandler` explicitly vouches with `replicate: true`.
  **Invariant:** a type may be `"ephemeral"` only if its effect is
  order-independent w.r.t. durable traffic _and_ self-heals if dropped, since the
  durable and ephemeral delivery paths carry no mutual ordering guarantee.
- **`requiresAck`** — whether receivers ack the message and senders track it
  in flight with NACK retransmit. Default `true`. `false` (carried on the wire
  as the `bestEffort` header byte) marks fire-and-forget best-effort traffic:
  never acked, never retransmitted, droppable under rate-limit pressure.
  `Awareness` (highest-frequency, clock-guarded, self-healing) and `Ack` itself
  are best-effort; RPC methods opt out per method via `qos.ack: false`.

`isBinaryMessage(bytes)` only checks the 3-byte magic, so it also returns `true`
for ping/pong frames — discriminate those first with `isPingMessage` /
`isPongMessage`.

## Ping/Pong

Heartbeat messages use a distinct 7-byte format (not the standard header):

```
Ping: [0x59 0x4a 0x53 0x70 0x69 0x6e 0x67]   "YJSping"
Pong: [0x59 0x4a 0x53 0x70 0x6f 0x6e 0x67]   "YJSpong"
```

## Pub/Sub envelope

For node-to-node messages over pub/sub:

```
[varString: sourceId]
[tail: BinaryMessage]
```

## Multi-message

Multiple messages can be batched into a single `MessageArray`:

```
per message: [varUint8Array: BinaryMessage]
```

## Milestone serialization

Milestones (document snapshots at a point in time) use their own binary format:

```
[0x59 0x4a 0x53]             magic
[0x01]                       version
[varString: documentId]
[varString: id]
[varString: name]
[float64: createdAt]
[uint8: flags]               bitfield for optional lifecycle fields
[optional lifecycle fields]
[uint8: createdBy type]      1=user, 0=system
[varString: createdBy id]
[tail: snapshot]             only in full encode (not meta-only)
```

`lifecycleState` is an optional field: a never-deleted milestone omits it from
the wire (the flag bit is 0) rather than writing the string `"active"`, keeping
the common-case frame minimal. Consumers treat a missing/`undefined`
`lifecycleState` as `"active"` — this is what `Milestone.toString()` renders and
what every storage backend's `getMilestones({ lifecycleState: "active" })`
filter matches.

## Update utilities

- `getEmptyUpdate()` / `isEmptyUpdate()` -- canonical empty V2 update
- `convertToV2()` / `convertSyncStep2ToV2()` -- version conversion
- `applyVersionedUpdate()` / `applyVersionedSyncStep2()` -- version-aware apply
- `mergeVersionedUpdates()` -- merge mixed V1/V2 updates
- `encodeVersionedBytes()` / `decodeVersionedBytes()` -- 1-byte version prefix + data

## Exports

All public APIs are re-exported from `./index.ts`.
