# Attribution RPC Methods

Read-only RPC methods that surface document **attribution** (authorship) to clients.

## Overview

When attribution storage is enabled, the server records an encoded **ContentMap**
per document — a mapping from CRDT operation ID ranges `(clientID, clock)` to
`userId` + `timestamp`. See [`teleportal/attribution`](../../lib/attribution) and the
`DocumentStorage.retrieveAttribution()` storage hook.

This protocol exposes that latent data on demand (it is **not** synced continuously).
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

RPC messages bypass the server's global permission check, so attribution-specific
authorization is supplied here:

```typescript
getAttributionRpcHandlers({
  checkPermission: (ctx) => canReadAttribution(ctx.userId, ctx.documentId),
});
```

When `checkPermission` returns `false` (or throws), the call fails with a `403`.

## Client Integration

The `Provider` exposes the methods directly:

```typescript
import { Provider } from "teleportal/providers";

const provider = await Provider.create({
  url: "wss://...",
  document: "my-doc",
});

// Activity timeline (optionally filtered).
const activity = await provider.getActivity({ userId: "user-1" });

// Who wrote characters 0..40 of a Y.Text?
const text = provider.doc.getText("body");
const segments = await provider.getAttributionForRange(text, 0, 40);
// -> [{ from, to, userId, timestamp }, ...]

// Point lookup by CRDT id, or the raw decoded ContentMap.
const author = await provider.resolveAttribution(clientID, clock);
const map = await provider.getAttributionMap();
```

`getAttributionMap()` fetches and caches the decoded ContentMap; the range/point
helpers reuse that cache, fetching once on first use.

## Methods

### attributionActivity

Activity timeline for the document.

**Request:** `{ from?: number; to?: number; userId?: string }` (timestamps in ms)

**Response:** `{ activity: Array<{ from: number; to: number; userId: string | null }> }`

Works for **encrypted** documents — it is derived purely from authorship and
timestamps and never needs the document content.

### attributionGet

The encoded ContentMap for client-side resolution.

**Request:** `{ filter?: { from?: number; to?: number; userId?: string } }`

**Response:** `{ contentMap: Uint8Array | null }` — `null` when the storage has no
attribution for the document. When a filter is supplied, the map is narrowed
server-side before encoding.

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

> Note: for E2EE documents, milestone snapshots are encrypted on the client (see the
> [milestone README](../milestone/README.md)); `Provider` decrypts them transparently before
> deriving operation IDs. Server-generated _automatic_ milestones on E2EE documents use a
> different snapshot format and are not consumed by these methods.

## Encryption boundary

For end-to-end-encrypted documents the server holds only ciphertext plus the
plaintext ContentMap. It **can** answer `attributionActivity`, but it **cannot** map
a content position to a CRDT id — only the client can, against its decrypted
document. `getAttributionForRange` (and the `resolveRangeAttribution` /
`collectRangeIds` utilities behind it) therefore run entirely client-side and work
identically for encrypted and unencrypted documents.

## See Also

- [`teleportal/attribution`](../../lib/attribution) - ContentMap types and query helpers
- [Protocols Overview](../README.md) - Package overview
- [Milestone Methods](../milestone/README.md) - Milestone CRUD operations via RPC
