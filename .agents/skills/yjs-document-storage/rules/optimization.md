---
title: Write Optimization for Y.Docs
impact: HIGH
tags: yjs, optimization, transactions, defaults, flattening
---

## Write Optimization for Y.Docs

**Impact: HIGH**

Every Y.js entry carries CRDT metadata, every `set` fires a sync message, every change fires an observer event. These optimizations cut payload size, reduce churn, and keep observers from seeing half-updated state — **without** sacrificing the concurrent-edit safety rules in `concurrency.md`.

### Batch Related Writes in a Single Transaction

Wrap related `Y.Map.set()` calls in `yDoc.transact(() => { ... })` so they apply as one atomic update. Result: one sync message, one observer event, and a consistent state for any observer.

```typescript
// Bad: each set fires a separate sync + observer event
yDoc.set("updatedBy", "user:123");
yDoc.set("updatedAt", Date.now());
yProps.set("title", "New Title");

// Good: one atomic update, one sync message, one observer event
doc.transact(() => {
  yDoc.set("updatedBy", "user:123");
  yDoc.set("updatedAt", Date.now());
  yProps.set("title", "New Title");
});
```

Apply this any time two or more `set` calls belong to the same logical change. Without it, observers can see a `updatedBy` that doesn't match the `updatedAt`, and you pay 3× the sync payload.

### Flatten Small Fixed-Shape Objects

For small objects with 2–3 fields that **always change together** (like `{ type: string, id: string }`), flatten into a single encoded string rather than a nested Y.Map.

Each Y.Map key is an independent CRDT entry. If the fields never change independently, the extra entries just add overhead — you're paying for concurrency support you'll never use.

```typescript
// Bad: nested Y.Map for a 2-field object that changes atomically
const yRef = new Y.Map();
yRef.set("type", "user");
yRef.set("id", "123");

// Good: single encoded string
yMap.set("createdBy", "user:123");
// Read: const [type, id] = value.split(":");
```

This is the same "group by how it changes" heuristic from `concurrency.md`, applied to objects rather than scalar fields. Only flatten when you're sure the fields are always written together.

### Avoid Storing Defaults on Initial Write

When initially populating a Y.Doc, skip fields whose value matches the well-known default (e.g. `visible: true` for columns, `desc: false` for sorts). Fewer entries on first write = smaller initial sync payload and smaller document.

This is an optimization for the **initial write only**. Once a field exists in the doc, update it normally.

```typescript
// Initial write — skip defaults
if (!column.visible) yColumn.set("visible", false); // only write if non-default
// Read: yColumn.get("visible") ?? true
```

### Don't Delete a Field to Revert to Default

Once a field exists, don't delete it just because the user set it back to the default value. The delete is itself a CRDT operation with overhead and causes unnecessary churn (observers fire, sync messages go out).

```typescript
// Later update — write normally even if it's the default value
yColumn.set("visible", true); // user toggled it back — just write it
```

The "skip defaults" optimization only pays off at initial population. After that, normal writes are cheaper than delete-then-write.

### Tombstones on Y.Map Keys Are Forever

Every `ymap.set(key, newValue)` internally creates a new item and **tombstones the previous item** for that key. Tombstones on Y.Map are **not garbage-collected across successive sets** — they accumulate for the life of the document.

Consequences:

- A key updated once a minute for a year carries ~525k tombstones, even though only the latest value is observable.
- Long-lived documents with heavy per-key churn can hit significant memory pressure on load. See [yjs#741](https://github.com/yjs/yjs/issues/741) for a real case where a 200 MB doc spikes to ~15 GB during `encodeStateAsUpdate` due to tombstones.

**How to avoid high-churn keys in the Y.Doc:**

- **Ephemeral high-frequency state → Awareness.** Cursor positions, typing indicators, "last seen at" pings. See `concurrency.md` on Awareness.
- **Monotonically-updated signals** (e.g. "last activity timestamp") → emit at coarser granularity (every minute, not every keystroke), or store in a separate rotatable Y.Doc you can rebuild on schedule.
- **Write-heavy counters** → single-writer keys in a Y.Map counts sub-map (see `concurrency.md`), rather than repeatedly overwriting one key.

Tombstones on _different_ keys don't share this problem — they're per-key. A Y.Map with 10k different keys each set once is cheap. A Y.Map with one key set 10k times is not.

### Plan for Document Deletion Up Front

You can't delete a top-level shared type (see `schema-design.md`). Combined with the tombstone-forever behavior above, this means a Y.Doc that was originally designed with lots of root-level types or one high-churn root key has no clean path to "shrink" later — you'd have to create a new document and migrate.

Before deciding where a high-churn field should live, ask: "will this ever need to be reset without migrating every client?" If yes, nest it somewhere you can `delete()`, or put it in a subdocument you can replace.
