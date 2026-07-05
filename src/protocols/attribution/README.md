# Attribution Protocol

Read-only RPC methods that surface document **attribution** (authorship) to clients.

## Overview

When attribution storage is enabled, the server records an encoded **ContentMap**
per document — a mapping from CRDT operation ID ranges `(clientID, clock)` to
authorship metadata (userId, timestamp, and optional custom attributes). See
[`teleportal/attribution`](../../lib/attribution/README.md) for the data model and
`DocumentStorage.retrieveAttribution()` for the storage hook.

This protocol answers two questions:

- **"What happened, and when?"** — an activity timeline, optionally filtered by user or time range.
- **"Who wrote this content?"** — the ContentMap, resolved client-side against the local document to attribute a range of content.

## File Structure

```
src/protocols/attribution/
  methods.ts   — method contracts (defineMethod/defineProtocol) + request/response types
  server.ts    — server handlers (createHandlers)
  client.ts    — client extension (createClientExtension)
  resolve.ts   — client-side range attribution helpers
  index.ts     — public exports
```

## Server Integration

```typescript
import { Server } from "teleportal/server";
import { getAttributionRpcHandlers } from "teleportal/protocols/attribution";

const server = new Server({
  storage: async () => storage, // must implement retrieveAttribution
  rpcHandlers: {
    ...getAttributionRpcHandlers(),
  },
});
```

Attribution methods are covered by the server's global `checkPermission` hook.
Use the `rpcMethod` field for method-level authorization:

```typescript
const server = new Server({
  storage: async (ctx) => storage,
  checkPermission: async ({ context, documentId, rpcMethod }) => {
    if (rpcMethod === "attributionActivity" || rpcMethod === "attributionGet") {
      return canReadAttribution(context.userId, documentId);
    }
  },
  rpcHandlers: {
    ...getAttributionRpcHandlers(),
  },
});
```

## Client Integration

```typescript
import { Provider } from "teleportal/providers";
import { createAttributionRpc } from "teleportal/protocols/attribution";

const provider = await Provider.create({
  url: "wss://...",
  document: "my-doc",
  rpc: {
    attribution: createAttributionRpc,
  },
});

// Activity timeline
const activity = await provider.rpc.attribution.getActivity({ userId: "user-1" });

// Who wrote characters 0..40 of a Y.Text?
const text = provider.doc.getText("body");
const segments = await provider.rpc.attribution.getForRange(text, 0, 40);

// Point lookup by CRDT id
const author = await provider.rpc.attribution.resolveItem(clientID, clock);

// Who deleted characters within a range?
const deleted = await provider.rpc.attribution.getDeletedForRange(text, 0, 40);

// Raw decoded ContentMap (cached after first fetch)
const map = await provider.rpc.attribution.getMap();

// Merge a server-pushed incremental ContentMap into the local cache
provider.rpc.attribution.mergeIncremental(incomingContentMap);

// Invalidate the cache when you know the map has changed
provider.rpc.attribution.invalidateCache();
```

## Contract

The protocol contract is defined in `methods.ts`:

```typescript
import { attributionProtocol } from "teleportal/protocols/attribution";

// attributionProtocol.methods:
//   activity         → wire name "attributionActivity"
//   get              → wire name "attributionGet"
//   getIncremental   → wire name "attributionGetIncremental"
```

All methods use type-first definitions (no schema validation).

## Milestones

Attribution can be scoped to [milestones](../milestone/README.md). This is done
entirely client-side (required for E2EE) via the attribution client extension:

```typescript
// Who authored the content present in milestone M?
const map = await provider.rpc.attribution.getMilestoneContentMap(milestoneId);

// Who made the changes between two milestones?
const map = await provider.rpc.attribution.getChangesetContentMap(fromId, toId);

// Activity scoped to a milestone or changeset
const activity = await provider.rpc.attribution.getActivity({ milestone: milestoneId });
const activity = await provider.rpc.attribution.getActivity({ changeset: [fromId, toId] });
```

## Encryption Boundary

Attribution works for E2EE documents without any encryption-specific handling. With
content-level encryption, the CRDT structure (client IDs, clocks, parents, delete sets)
stays in **plaintext**; only the document content is encrypted into sidecars. The server
derives the CRDT operation IDs `(clientID, clock)` directly from the plaintext structure
update and tags them with userId/timestamp to build the ContentMap.

The server **can** answer `attributionActivity` (derived from the plaintext structure),
but it **cannot** map a content position to a CRDT id — only the client can, against its
decrypted document. `getForRange` (and `resolveRangeAttribution` / `collectRangeIds`)
run entirely client-side.

## Custom Attributes

Attribution supports custom metadata beyond the standard `userId` / `timestamp` fields:

```typescript
const server = new Server({
  storage: async (ctx) => storage,
  attributionConfig: {
    getAttributes: ({ context }) => ({
      source: context.source ?? "human",
    }),
  },
  rpcHandlers: {
    ...getAttributionRpcHandlers(),
  },
});
```

Custom attributes are stored alongside standard attributes and can be filtered
via the `attributes` field on both `attributionActivity` and `attributionGet`.

## Methods

### attributionActivity

Activity timeline for the document.

**Request:** `{ from?: number; to?: number; userId?: string; attributes?: Record<string, unknown> }`

**Response:** `{ activity: ActivityEntry[] }`

### attributionGet

The encoded ContentMap for client-side resolution.

**Request:** `{ filter?: AttributionFilter }`

**Response:** `{ contentMap: EncodedContentMap | null }`

`null` when the storage has no attribution data. When a filter is supplied, the map is
narrowed server-side before encoding.

### attributionGetIncremental

Diff-based ContentMap fetch. The client sends the operation IDs it already has; the
server returns only the ranges the client is missing.

**Request:** `{ knownIds: EncodedContentIds }`

**Response:** `{ contentMap: EncodedContentMap | null }`

`null` when the storage has no attribution data. Otherwise returns the ContentMap
with ranges present in `knownIds` excluded.

## See Also

- [`teleportal/attribution`](../../lib/attribution/README.md) — ContentMap data model, set operations, and query helpers
- [`teleportal/rpc`](../../lib/rpc/) — RPC framework primitives
- [Milestone Protocol](../milestone/README.md) — Milestone CRUD operations
