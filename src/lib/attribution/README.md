# Attribution

Content attribution (authorship tracking) for Y.js documents. Tracks who inserted
or deleted each operation, and when, as a compact binary-encoded ContentMap.

This is the core data layer — pure functions over ID sets and attributed maps, with
no network or Y.js document dependency (except `createContentIdsFromUpdate` which
decodes Y.js updates). The protocol layer ([`teleportal/protocols/attribution`](../../protocols/attribution/README.md))
and provider API ([`teleportal/providers`](../../providers/README.md)) build on top of this.

## Background

The data model is based on [Y.js v14](https://github.com/yjs/yjs)'s ContentMap format,
originally implemented in [yhub](https://github.com/yjs/yhub). Teleportal reimplements
these structures in TypeScript against Y.js v13's `decodeUpdate` API, but maintains
format and semantic compatibility with the v14 design. When teleportal upgrades to v14,
`createContentIdsFromUpdate` can be replaced with v14's native implementation and the
set operations / encoding can be swapped for `@y/y` exports.

## Data Model

### Operation IDs

Every Y.js CRDT operation has a unique ID: `(clientID, clock)`. Consecutive operations
from the same client form contiguous ranges `(clientID, clock, length)`. The attribution
system works entirely in this ID space — it never touches document content directly.

### ContentIds

A pair of `IdSet`s representing which operations exist in a Y.js update:

```typescript
interface ContentIds {
  inserts: IdSet; // operations that insert content
  deletes: IdSet; // operations that delete content
}
```

Created from a Y.js update:

```typescript
import { createContentIdsFromUpdate } from "teleportal/attribution";

const ids = createContentIdsFromUpdate(update);
// ids.inserts: IdSet — all insert operations in the update
// ids.deletes: IdSet — all delete operations in the update
```

### ContentMap

Extends ContentIds by attaching `ContentAttribute[]` metadata to each operation range:

```typescript
interface ContentMap {
  inserts: IdMap; // insert ranges with attribution attributes
  deletes: IdMap; // delete ranges with attribution attributes
}
```

Each range in an `IdMap` carries an array of `ContentAttribute` name/value pairs.

### Standard Attributes

These attribute names follow the Y.js v14 / yhub convention and are a compatibility
contract with that ecosystem:

| Attribute  | Applied to | Value                   | Meaning                      |
| ---------- | ---------- | ----------------------- | ---------------------------- |
| `insert`   | inserts    | `string` (userId)       | Who created the content      |
| `insertAt` | inserts    | `number` (ms timestamp) | When the content was created |
| `delete`   | deletes    | `string` (userId)       | Who deleted the content      |
| `deleteAt` | deletes    | `number` (ms timestamp) | When the content was deleted |

These are always applied as pairs: `insert` + `insertAt` on inserts, `delete` + `deleteAt`
on deletes.

### Custom Attributes

Custom attributes are stored flat alongside the standard attributes. The same
custom attributes are attached to both the insert and delete sides:

```typescript
import { createContentAttribute, createContentMapFromContentIds } from "teleportal/attribution";

const contentMap = createContentMapFromContentIds(
  contentIds,
  [
    createContentAttribute("insert", userId),
    createContentAttribute("insertAt", Date.now()),
    createContentAttribute("source", "ai"),
    createContentAttribute("model", "claude-4"),
  ],
  [
    createContentAttribute("delete", userId),
    createContentAttribute("deleteAt", Date.now()),
    createContentAttribute("source", "ai"),
    createContentAttribute("model", "claude-4"),
  ],
);
```

Custom attributes are encoded, stored, and filtered alongside standard attributes.
The insert/delete distinction comes from which side of the ContentMap they live on,
not from the attribute name.

## Creating a ContentMap

The typical server-side flow:

```typescript
import {
  createContentIdsFromUpdate,
  createContentMapFromContentIds,
  createContentAttribute,
  encodeContentMap,
} from "teleportal/attribution";

// 1. Extract operation IDs from the incoming Y.js update
const contentIds = createContentIdsFromUpdate(update);

// 2. Tag with attribution metadata
const contentMap = createContentMapFromContentIds(
  contentIds,
  [createContentAttribute("insert", userId), createContentAttribute("insertAt", Date.now())],
  [createContentAttribute("delete", userId), createContentAttribute("deleteAt", Date.now())],
);

// 3. Encode to binary for storage
const encoded = encodeContentMap(contentMap);
```

## Set Operations

All operations are pure — they return new instances without mutating inputs.

### Merge

Combine multiple ContentMaps (e.g. from concurrent updates):

```typescript
import { mergeContentMaps } from "teleportal/attribution";

const merged = mergeContentMaps([mapA, mapB, mapC]);
```

When ranges overlap, the most-recently-added range wins the contested span.

### Filter

Keep only ranges whose attributes match a predicate:

```typescript
import { filterContentMap } from "teleportal/attribution";

const filtered = filterContentMap(contentMap, (attrs) => {
  const userAttr = attrs.find((a) => a.name === "insert");
  return userAttr?.val === "user-123";
});
```

`filterContentMap` accepts separate predicates for inserts and deletes. When only one
is provided, it is used for both.

### Intersect

Keep only ranges present in both a ContentMap and ContentIds:

```typescript
import { intersectContentMap } from "teleportal/attribution";

// Attribution scoped to a milestone's operations
const scoped = intersectContentMap(fullMap, milestoneIds);
```

### Exclude

Remove ranges already present in a ContentIds set (prevents double-attribution):

```typescript
import { excludeContentMap } from "teleportal/attribution";

const newOnly = excludeContentMap(fullMap, alreadyAttributedIds);
```

### ContentIds operations

The same algebra exists at the `ContentIds` / `IdSet` level (without attributes):

```typescript
import { mergeContentIds, excludeContentIds, intersectContentIds } from "teleportal/attribution";

const merged = mergeContentIds([idsA, idsB]);
const diff = excludeContentIds(toIds, fromIds); // operations in `to` but not `from`
const common = intersectContentIds(idsA, idsB); // operations in both
```

## Binary Encoding

ContentMaps and ContentIds encode to compact binary using `lib0`'s variable-length
integer encoding with two layers of deduplication:

- **Attribute deduplication**: identical `(name, value)` pairs are written once and
  referenced by index thereafter.
- **Name deduplication**: attribute names are written once and referenced by index.
- **Delta encoding**: operation clocks are delta-encoded within each client's range list.

```typescript
import {
  encodeContentMap,
  decodeContentMap,
  encodeContentIds,
  decodeContentIds,
} from "teleportal/attribution";

const encoded = encodeContentMap(contentMap); // Uint8Array (branded as EncodedContentMap)
const decoded = decodeContentMap(encoded); // ContentMap

const encodedIds = encodeContentIds(contentIds); // Uint8Array (branded as EncodedContentIds)
const decodedIds = decodeContentIds(encodedIds); // ContentIds
```

## Query Helpers

### Activity Timeline

Extract a sorted timeline of editing activity from a ContentMap:

```typescript
import { getActivity } from "teleportal/attribution";

const activity = getActivity(contentMap, {
  from: startTimestamp, // optional, ms
  to: endTimestamp, // optional, ms
  userId: "user-123", // optional
  attributes: { "insert:source": "ai" }, // optional, equality match
});
// → [{ from, to, userId, attributes: { insert, insertAt, "insert:source", ... } }, ...]
```

Each entry includes an `attributes` record containing all attributes (standard and custom)
on the underlying operations. Adjacent entries from the same user within 1 second are
grouped into a single entry, but only when their `attributes` records are identical —
entries from the same user but different custom attributes stay separate.

### Point Lookup

Resolve who authored a specific Y.js item by its CRDT ID:

```typescript
import { resolveItemAttribution } from "teleportal/attribution";

const result = resolveItemAttribution(contentMap, clientID, clock);
// → { userId, timestamp, attributes: Record<string, unknown> } | null
```

## Milestone Composition

Attribution can be scoped to milestones using pure set operations — no Y.js document
dependency at this layer.

```typescript
import { milestoneContentMap, changesetContentMap } from "teleportal/attribution";

// Who authored the content present in a milestone?
const scoped = milestoneContentMap(fullMap, milestoneIds);
// → intersectContentMap(fullMap, milestoneIds)

// Who made the changes between two milestones?
const changeset = changesetContentMap(fullMap, fromIds, toIds);
// → intersectContentMap(fullMap, excludeContentIds(toIds, fromIds))
```

The milestone snapshot → ContentIds extraction step happens at the call site (typically
the client), which is what keeps this E2EE-safe: the server never needs to see the
decrypted snapshot.

## Exports

All public API is exported from `teleportal/attribution`:

```typescript
// Data structures
(ContentAttribute, createContentAttribute);
(IdSet, IdRange, IdRanges, MaybeIdRange, ContentIds, createContentIds);
(IdMap, AttrRange, MaybeAttrRange, AttrRanges, ContentMap, createContentMap);

// Construction
createContentIdsFromUpdate; // Y.js update → ContentIds
createContentMapFromContentIds; // ContentIds + attrs → ContentMap
createContentIdsFromContentMap; // ContentMap → ContentIds (strip attrs)

// Set operations
(mergeContentIds, excludeContentIds, intersectContentIds);
(mergeContentMaps, filterContentMap, excludeContentMap, intersectContentMap);
(mergeIdSets, diffIdSet, intersectIdSets);

// Encoding
EncodedContentIds;
(encodeContentIds, decodeContentIds, getEmptyEncodedContentIds);
(encodeContentMap, decodeContentMap);

// Queries
(ActivityEntry, getActivity, resolveItemAttribution);

// Milestone composition
(milestoneContentMap, changesetContentMap);
```

## See Also

- [`teleportal/protocols/attribution`](../../protocols/attribution/README.md) — RPC methods and client-side range resolution
- [`teleportal/providers`](../../providers/README.md) — Provider API for attribution queries
- [`teleportal/storage`](../../storage/README.md) — Storage interface (`handleUpdate`, `retrieveAttribution`)
