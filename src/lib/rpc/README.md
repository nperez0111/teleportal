# RPC Framework

Thin authoring layer for defining type-safe RPC protocols. Eliminates boilerplate while producing handlers and client methods that plug directly into the existing `rpc` wire message (type `0x04`) and session dispatch — see [`protocol/README.md`](../protocol/README.md#rpc-message-type-0x04) for the on-the-wire framing.

## Overview

Every RPC protocol in Teleportal is defined by a **contract** (`defineMethod` / `definePush` + `defineProtocol`), implemented with **server handlers** (`createHandlers`), and consumed via a **client extension** (`createClientExtension`). The framework provides:

- **`defineMethod`** — single source of truth for a method's wire name, request/response types, and optional validation
- **`definePush`** — unsolicited notification methods (server→client and node→node) with per-method delivery QoS
- **`defineProtocol`** — groups related methods under ergonomic keys
- **`createHandlers`** — type-safe server handler registration with automatic validation, error wrapping, and codec pass-through
- **`createClientExtension`** — type-safe client extension factory with auto-generated or custom client methods
- **`ok` / `err`** — structured result constructors (discriminated union, can't collide with data payloads)
- **`RpcOperationError`** — generic error class for client-side RPC failures

## Quick Start: Adding a New Protocol

### 1. Define the contract (`methods.ts`)

```typescript
import { defineMethod, defineProtocol } from "teleportal/rpc";

export const commentList = defineMethod<
  "commentList",
  { cursor?: string; limit?: number },
  { comments: Comment[]; nextCursor?: string }
>("commentList");

export const commentCreate = defineMethod<
  "commentCreate",
  { text: string; parentId?: string },
  { comment: Comment }
>("commentCreate");

export const commentProtocol = defineProtocol("comments", {
  list: commentList,
  create: commentCreate,
});
```

### 2. Implement server handlers (`server.ts`)

```typescript
import { createHandlers, ok, err } from "teleportal/rpc";
import { commentProtocol } from "./methods";

export function getCommentRpcHandlers(db: CommentDB) {
  return createHandlers(
    commentProtocol,
    { db },
    {
      list:
        ({ db }) =>
        async (payload, ctx) => {
          const result = await db.comments.find({
            documentId: ctx.documentId,
            cursor: payload.cursor,
            limit: payload.limit ?? 50,
          });
          return ok({ comments: result.items, nextCursor: result.nextCursor });
        },

      create:
        ({ db }) =>
        async (payload, ctx) => {
          if (!ctx.userId) return err(401, "Authentication required");
          const comment = await db.comments.insert({
            documentId: ctx.documentId,
            text: payload.text,
            userId: ctx.userId,
          });
          return ok({ comment });
        },
    },
  );
}
```

### 3. Create the client extension (`client.ts`)

For a simple protocol, auto-generate the client (no `client.ts` file needed):

```typescript
import { createClientExtension } from "teleportal/rpc";
import { commentProtocol } from "./methods";

export const createCommentRpc = createClientExtension(commentProtocol);
```

For domain transforms, use a custom `build` function:

```typescript
export const createCommentRpc = createClientExtension(commentProtocol, {
  build(methods, ctx) {
    return {
      async list(cursor?: string) {
        const response = await methods.list({ cursor, limit: 50 });
        return response.comments;
      },
      async create(text: string) {
        const response = await methods.create({ text });
        return response.comment;
      },
    };
  },
});
```

### 4. Wire it up

```typescript
// Server
const server = new Server({
  rpcHandlers: {
    ...getCommentRpcHandlers(db),
  },
});

// Client
const provider = await Provider.create({
  url: "wss://...",
  document: "my-doc",
  rpc: {
    comments: createCommentRpc,
  },
});

await provider.rpc.comments.list({ limit: 10 });
await provider.rpc.comments.create({ text: "Hello" });
```

## Method Kinds

- **`"request-response"`** (default) — simple request/response. Handler returns `ok(value)` or `err(status, details)`.
- **`"multipart"`** — has both a `handler` (initiation) and a `streamHandler` (chunk processing). Used by the file protocol for chunked transfers.
- **`"push"`** — an unsolicited notification, defined with `definePush`. On the wire it is a `response` with no `originalRequestId` — correlated to no request.

## Push Methods (`definePush`)

A push is fire-and-forget: it has a payload but no response. Define it with a name, an optional payload schema/codec, and per-method delivery **QoS**:

```typescript
import { definePush, defineProtocol } from "teleportal/rpc";

export const presenceRoster = definePush<"presenceRoster", PresenceRosterPayload>(
  "presenceRoster",
  { qos: { durability: "durable" } },
);
```

### QoS knobs (`RpcMethodQos`)

Push defaults: `{ durability: "ephemeral", replicate: true, ack: true, dedupe: true }`.

- **`durability`** (`"durable" | "ephemeral"`) — which pub/sub lane the message rides when replicated (durable = persisted and replayed after a blip).
- **`replicate`** — whether the authoring node publishes the push over pub/sub (the document topic) to other nodes at all.
- **`ack`** — whether receivers ack it and senders retransmit on NACK. `false` = best-effort fire-and-forget, carried on the wire as the `bestEffort` header byte: never acked, never in-flight-tracked, droppable under rate-limit pressure.
- **`dedupe`** — whether the cross-node replication path runs TTL dedup, which drops a message whose id was already seen. Every authored `RpcMessage` carries a nonce, so this only ever collapses genuine redeliveries of one message; repeating a payload (a periodic roster snapshot, an empty pull) is fine and needs no opt-out. Turn it off only for a handler that must observe even true duplicate deliveries.

### Server side: `pushHandler` and the session primitives

In `createHandlers`, a push method's handler is a **`pushHandler(payload, ctx)`**. It runs for pushes authored by a local client _and_ for pushes replicated from another node. Its `RpcPushContext` carries `server`, `session`, `documentId`, `sourceNodeId` (set for replicated pushes; `undefined` for local clients) and `clientId` (the server-assigned connection id of the local sender; `undefined` for replicated pushes). Return `{ forwardToLocalClients: false }` to suppress the default relay to this node's local clients. Client-authored pushes are **never replicated to other nodes by default** — replication is a trusted node-to-node plane (receiving nodes apply replicated pushes as server-authored), so a registered `pushHandler` must explicitly vouch with `{ replicate: true }` after inspecting the payload. Unregistered methods relay client pushes to same-node peers only. (`qos.replicate` governs server-authored pushes sent via the session primitives.)

To author pushes, `Session` exposes:

- **`session.sendRpcToClient(clientOrId, method, payload, opts?)`** — push to one local client.
- **`session.broadcastRpc(method, payload, { excludeClientId?, encrypted?, qos? })`** — push to all local clients, plus a pub/sub publish when the method's QoS says `replicate`.
- **`session.publishRpc(method, payload, opts?)`** — node-to-node only, no local broadcast.

Each resolves the method's declared QoS from the handler registry (a per-call `qos` override is merged on top; unregistered methods get push defaults).

### Client side: extension hooks

Pushes arrive at the provider as RPC responses with no request to correlate against; a client extension consumes them via the **`handleMessage(message)`** hook (return `true` when consumed). Related hooks on `createClientExtension` / `RpcExtension`:

- **`handleMessage(message)`** — route incoming RPC messages (pushes) to extension state.
- **`handleAck(message)`** — observe ack/NACK messages.
- **`onConnect()`** — invoked by the provider on every (re)connect, after the doc sync handshake has been started and before the awareness resync — the deterministic slot for announce-style traffic that must follow sync-step-1 (presence announces here).
- **`destroy()`** — cleanup on provider destroy.

See `teleportal/protocols/presence` for a complete protocol built on pushes.

## Schema Validation

Methods can optionally use [Standard Schema](https://github.com/standard-schema/standard-schema) validators for automatic request validation:

```typescript
import * as v from "valibot";

const commentCreate = defineMethod("commentCreate", {
  request: v.object({
    text: v.pipe(v.string(), v.minLength(1)),
    parentId: v.optional(v.string()),
  }),
  response: v.object({ comment: commentSchema }),
});
```

When a method has a `requestSchema`, `createHandlers` validates the incoming payload before calling the handler. Invalid payloads get a `400` error response with structured validation issues.

Schemas are optional — methods without schemas (type-first mode) skip validation entirely.

## Custom Codecs

Methods can provide custom binary encode/decode for the wire format, overriding the default lib0 `encodeAny`/`decodeAny`:

```typescript
const milestoneGet = defineMethod<"milestoneGet", GetRequest, GetResponse>("milestoneGet", {
  responseCodec: {
    encode: (payload) => customBinaryEncode(payload),
    decode: (bytes) => customBinaryDecode(bytes),
  },
});
```

Codecs are passed through to the `RpcServerRequestHandler`'s `request`/`response`/`stream` properties, which session.ts uses at send time.

## Error Handling

### Server side

Handlers return `ok(value)` or `err(statusCode, details)`. Unexpected throws are caught and translated to `err(500, message)` automatically.

### Client side

`RpcOperationError` is the generic error for client-side RPC failures:

```typescript
import { RpcOperationError } from "teleportal/rpc";

try {
  await provider.rpc.comments.create({ text: "" });
} catch (error) {
  if (error instanceof RpcOperationError) {
    error.protocol; // "comments"
    error.operation; // "create"
    error.cause; // underlying RPC error
  }
}
```

Auto-generated and custom client methods both wrap errors automatically. The `wrapError` option on `createClientExtension` lets you substitute a custom error class if needed.

## Exports

```typescript
import {
  // Contract
  defineMethod,
  definePush,
  defineProtocol,

  // Server
  createHandlers,
  ok,
  err,

  // Client
  createClientExtension,

  // Error
  RpcOperationError,

  // Types
  type MethodDef,
  type ProtocolDef,
  type MethodKind,
  type RpcResult,
  type Codec,
  type RpcServerContext,
  type RpcPushContext,
  type RpcMethodQos,
  type RpcHandlerRegistry,
  type RpcExtension,
  type RpcExtensionContext,
} from "teleportal/rpc";
```

## See Also

- [Presence Protocol](../../protocols/presence/README.md)
- [Milestone Protocol](../../protocols/milestone/README.md)
- [File Protocol](../../protocols/file/README.md)
- [Key Registry Protocol](../../protocols/key-registry/README.md)
- [Attribution Protocol](../../protocols/attribution/README.md)
