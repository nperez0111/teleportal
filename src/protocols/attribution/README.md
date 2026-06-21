# Attribution RPC Methods

Read-only RPC methods that surface document **attribution** (authorship) to clients.

## Overview

When attribution storage is enabled, the server records an encoded **ContentMap**
per document — a mapping from CRDT operation ID ranges `(clientID, clock)` to
authorship metadata (userId, timestamp, and optional custom attributes). See
[`teleportal/attribution`](../../lib/attribution/README.md) for the data model and
`DocumentStorage.retrieveAttribution()` for the storage hook.

This protocol exposes that data on demand (it is **not** synced continuously).
It answers two questions:

- **"What happened, and when?"** — an activity timeline, optionally filtered by user
  or time range.
- **"Who wrote this content?"** — the ContentMap, resolved client-side against the
  local document to attribute a range of content.

## Server Integration

```typescript
import { Server } from "teleportal/server";
import { getAttributionRpcHandlers } from "teleportal/protocols/attribution";

const server = new Server({
  // ... other options (storage must implement retrieveAttribution)
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
    // ... other permission logic
  },
  rpcHandlers: {
    ...getAttributionRpcHandlers(),
  },
});
```

When `checkPermission` returns `false` (or throws), the RPC call fails with a `403`.

## Client Integration

The `Provider` exposes the methods directly:

```typescript
import { Provider } from "teleportal/providers";

const provider = await Provider.create({
  url: "wss://...",
  document: "my-doc",
});

// Activity timeline — composable filters
const activity = await provider.getActivity({ userId: "user-1" });
const milestoneActivity = await provider.getActivity({ milestone: milestoneId });
const changeset = await provider.getActivity({ changeset: [fromId, toId] });

// Who wrote characters 0..40 of a Y.Text?
const text = provider.doc.getText("body");
const segments = await provider.getAttributionForRange(text, 0, 40);
// -> [{ from, to, userId, timestamp, attributes }, ...]

// Point lookup by CRDT id, or the raw decoded ContentMap.
const author = await provider.resolveAttribution(clientID, clock);
const map = await provider.getAttributionMap();
```

`getAttributionMap()` fetches and caches the decoded ContentMap; the range/point
helpers reuse that cache, fetching once on first use.

## Methods

### attributionActivity

Activity timeline for the document.

**Request:** `{ from?: number; to?: number; userId?: string; attributes?: Record<string, unknown> }`
(timestamps in ms; `attributes` is an equality-match filter on attribute values by name)

**Response:** `{ activity: Array<{ from, to, userId, attributes }> }` — each entry
includes an `attributes` record with all standard and custom attributes.

Works for **encrypted** documents — it is derived purely from authorship metadata
and never needs the document content.

### attributionGet

The encoded ContentMap for client-side resolution.

**Request:** `{ filter?: { from?: number; to?: number; userId?: string; attributes?: Record<string, unknown> } }`

**Response:** `{ contentMap: Uint8Array | null }` — `null` when the storage has no
attribution for the document. When a filter is supplied (including custom attribute
filters), the map is narrowed server-side before encoding.

## Milestones

Attribution can be scoped to [milestones](../milestone/README.md). A milestone snapshot is
a full Y.js update, so the operations it contains are `createContentIdsFromUpdate(snapshot)`;
milestone attribution is then pure set composition over the document's ContentMap. This is
done **entirely client-side** (the server stays out of it, which is required for E2EE), via
`Provider`:

```typescript
// Who authored the content present in milestone M?
const activity = await provider.getMilestoneActivity(milestoneId);
const map = await provider.getMilestoneContentMap(milestoneId);

// Who made the changes between two milestones?
const changeset = await provider.getChangesetActivity(fromId, toId);

// Who wrote chars i..j as of milestone M? (rebuilds M's doc locally)
const segments = await provider.getMilestoneAttributionForRange(
  milestoneId,
  (doc) => doc.getText("body"),
  0,
  40,
);
```

The underlying pure helpers live in `teleportal/attribution`:
`milestoneContentMap(fullMap, milestoneIds)` and
`changesetContentMap(fullMap, fromIds, toIds)`.

> Note: for E2EE documents, milestone snapshots are content-encrypted payloads (a plaintext
> structure update plus encrypted sidecars), whether created on the client or as
> server-generated _automatic_ milestones — both use the same format. `Provider` decrypts
> them transparently before deriving operation IDs, so both are consumed uniformly by these
> methods.

## Encryption boundary

Attribution works for E2EE documents without any encryption-specific handling. With
content-level encryption the CRDT structure (client IDs, clocks, parents, delete sets)
stays in **plaintext**; only the document content is encrypted into sidecars. The server
therefore derives the CRDT operation IDs `(clientID, clock)` directly from the plaintext
structure update — the same code path as unencrypted documents — and tags them with
userId/timestamp to build the ContentMap. The client does **not** extract or ship
content IDs separately; nothing extra travels alongside the ciphertext. These IDs are
structural metadata: they reveal which client wrote how many operations, never the
content itself.

The server **can** answer `attributionActivity` (derived from the plaintext structure),
but it **cannot** map a content position to a CRDT id — only the client can, against its
decrypted document. `getAttributionForRange` (and the `resolveRangeAttribution` /
`collectRangeIds` utilities behind it) therefore run entirely client-side and work
identically for encrypted and unencrypted documents.

## Custom Attributes

Attribution supports custom metadata beyond the standard `userId` / `timestamp` fields.
To attach custom attributes, provide an `attributionConfig` when creating the server.
The returned attributes are stored as-is on both the insert and delete sides of the
ContentMap:

```typescript
import { Server } from "teleportal/server";

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

Custom attributes are encoded, stored, and transmitted alongside standard attributes.
They can be used for AI agent tagging, change source tracking, or any domain-specific
metadata.

## Server Events

The server emits a `document-attribution` event on every attributed update, providing
a hook for implementations that need to react to attribution changes in real-time:

```typescript
server.on(
  "document-attribution",
  ({ documentId, namespacedDocumentId, sessionId, userId, timestamp, contentMap }) => {
    // contentMap is the EncodedContentMap for just this update (not the full document)
  },
);
```

This event fires for both encrypted and unencrypted documents.

## See Also

- [`teleportal/attribution`](../../lib/attribution/README.md) — ContentMap data model, set operations, and query helpers
- [Protocols Overview](../README.md) — Package overview
- [Milestone Methods](../milestone/README.md) — Milestone CRUD operations via RPC
- [`teleportal/providers`](../../providers/README.md) — Provider API for attribution queries
