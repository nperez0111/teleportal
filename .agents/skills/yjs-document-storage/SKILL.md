---
name: yjs-document-storage
description: Y.js document storage guidelines for concurrent-edit safety, schema evolution, and minimal CRDT overhead
license: MIT
metadata:
  version: "1.0.0"
---

# Y.js Document Storage Skill

Version: 1.0.0

## Purpose

This skill provides guidelines for encoding application data into Y.js documents. A Y.Doc is the **source of truth** for your data — once clients are syncing against a particular structure, changing that structure is a migration, not a refactor. Treat a Y.Doc layout like a database schema or wire protocol: correct now, extendable later, and shaped around how users actually concurrently edit.

The goal: **maximize concurrent-edit safety** and **minimize CRDT overhead** (storage, sync payload, observer churn).

## When to Apply

Apply these guidelines when:

- Designing the shape of a new Y.Doc
- Adding a new field, collection, or entity to an existing Y.Doc
- Reviewing code that calls `Y.Map.set`, `Y.Array.insert`, `new Y.Text`, or serializes structures into Y.js values
- Debugging a sync/merge anomaly (corrupted strings, lost writes on concurrent edits, oversized documents)
- Splitting data across Y.Docs for permissions or lazy-loading

## Core Principles

### 1. Y.Doc Is a Schema (CRITICAL)

Design for your domain's growth axes. Use **maps keyed by ID** for collections. Reserve **top-level keys** for major concepts. Prefer **flat, typed values** over deeply nested structures. **Never** serialize a whole object as a JSON string into one Y.js value — you lose granular merging and every concurrent edit conflicts with every other edit.

### 2. Group by Change, Not by Description (CRITICAL)

For each pair of fields ask: *"Will two users ever edit these at the same time?"*

- **Always change together** (e.g. `updatedBy` + `updatedAt`) → one atomic value.
- **Can change independently** (e.g. `title` vs. `status`) → separate entries.
- **User types into it** → `Y.Text`. **Selected from a set** → plain value.

Match Y.js granularity to your UI's editing surface.

### 3. `Array<Object>` → `Map<id, Object>` (CRITICAL)

`Y.Array<Object>` is fine for append-only lists (logs, chat), but breaks for user-editable collections. A "move" is actually `delete` + `insert`, which creates a *new* item — concurrent edits to the "moved" original are lost, and two users reordering can produce duplicates. Index-based references also shift on concurrent inserts.

Use `Y.Map<id, Y.Map<field, value>>` so each entity has a stable identity. For user-controlled ordering, use **fractional indexing** (string indices between neighbors) rather than integer positions, which collide when two users reorder at the same time.

### 4. Known Set of Strings → Number (HIGH)

Y.Map value writes are **last-writer-wins by `clientID`** (the client with the higher `clientID` wins — not the later timestamp). Concurrent writes of different string values don't corrupt each other (no character-level merge happens on a Y.Map string — that only happens with `Y.Text`). But numbers are still preferred for known enums:

- **Smaller encoding** in the Yjs binary format than short strings.
- **Cheap to change** the string labels without migrating every document.
- **Clear intent**: "this is a choice, not typed text" — matches `Y.Text` vs. plain-value guidance in principle 9.

### 5. Think About What the User Can Edit (HIGH)

Not everything needs granular CRDT storage:

- **UI-editable** (filters, column widths) → decomposed Y.Map / Y.Array.
- **Write-once metadata** (createdAt, createdBy) → plain value.
- **Small, rarely-edited data** (enum options) → JSON string is acceptable.

### 6. If You Can Derive It, Don't Store It (HIGH)

Remove redundant fields: ID is already the map key; parent context (e.g. `collectionId`) is the containing map; computable values (e.g. `size`) come from `.size`.

### 7. Batch Writes in a Transaction (HIGH)

Wrap related `set` calls in `yDoc.transact(() => { ... })` so they apply as one update — one sync message, one observer event, consistent state.

### 8. Flatten Small Fixed-Shape Objects (MEDIUM)

For 2–3 field objects that always change together (e.g. `{ type, id }`), encode as a single string (`"user:123"`). A nested Y.Map wastes CRDT metadata on concurrency you'll never use.

### 9. `Y.Text` for Collaboratively Edited Strings (HIGH)

`Y.Text` uses a character-level CRDT that merges concurrent keystrokes. Use it for strings users type into. For strings swapped wholesale (dropdown selection), use a plain value.

### 10. Avoid Storing Defaults (MEDIUM)

On **initial write**, skip fields whose value matches a well-known default. Don't delete a field when a user sets it back to default — the delete is itself a CRDT op with overhead and causes churn. This is an initial-payload optimization only.

### 11. Split Y.Docs When Permissions Differ (CRITICAL)

Permissions can't be enforced *inside* a Y.Doc — any client that can sync it reads and writes everything. Split into an **index Y.Doc** (IDs + metadata) and **per-entity Y.Docs** (content) when:

- Different entities need different read/write permissions
- You need to revoke access to specific entities
- Entity data is large and lazy-loading matters

Don't split when permissions are uniform and the overhead isn't justified.

### 12. Use Awareness for Ephemeral State, Not the Y.Doc (CRITICAL)

Cursor positions, text selections, typing indicators, "who's online," hover state — put these in the **Awareness** protocol, not the Y.Doc. Awareness is:

- **Ephemeral**: state lives only while the client is connected; auto-cleans on disconnect.
- **Per-session**: keyed by `clientID` by default, so no concurrent-write problem.
- **Not persisted**: doesn't grow the document or its history.

Putting ephemeral state in the Y.Doc pollutes history, accumulates tombstones forever (see #16), and syncs noise to every peer on every move.

### 13. Single-Writer Keys for Counters and Shared Tallies (CRITICAL)

Y.Map is LWW-by-`clientID`, so read-modify-write loses writes under concurrency — `ymap.set("count", ymap.get("count") + 1)` silently drops one increment when two clients run it at once.

Pattern: give each client its own key and aggregate on read.

```typescript
// Bad: concurrent increments lose writes
ymap.set("count", (ymap.get("count") ?? 0) + 1);

// Good: each client has its own key
const counts = ymap.get("counts") as Y.Map<number>;
counts.set(String(ydoc.clientID), (counts.get(String(ydoc.clientID)) ?? 0) + 1);
// Read: [...counts.values()].reduce((a, b) => a + b, 0)
```

Apply to view counts, reaction tallies, "who's in this room" sets, and any other accumulating shared value.

### 14. Don't Mutate JSON Retrieved From a Shared Type (HIGH)

Yjs does **not** clone values when you `set` or `get` them. Mutating a returned object changes local state without firing any update, causing silent divergence from remote peers:

```typescript
// Bad: mutates in place — no update fires, remote peers never see the change
const meta = ymap.get("meta");
meta.foo = "bar"; // silently diverges

// Good: read, derive a new value, set it back
const meta = { ...ymap.get("meta"), foo: "bar" };
ymap.set("meta", meta);
```

Prefer primitives or nested `Y.Map` for mutable structures. Reserve JSON blobs for data that's always rewritten wholesale (see #5).

### 15. Shared Types Can't Be Moved Once Inserted (HIGH)

A `Y.Map`, `Y.Array`, or `Y.Text` is bound to its parent forever. "Moving" a shared type between containers is actually copy-and-delete, which:

- Creates a **new** shared-type instance at the destination.
- Loses any concurrent edits happening on the original.
- Breaks references other code holds to the original.

Design nesting so you don't need to relocate shared types. If data logically moves between containers, store a reference (ID) rather than the shared type itself, and keep the actual shared type in a flat top-level map.

### 16. Tombstones on Y.Map Keys Are Forever (MEDIUM)

Every `ymap.set(key, ...)` creates a new internal item and tombstones the previous one. Tombstones are not garbage-collected across sets — they accumulate on high-churn keys.

Consequences:

- A cursor-position field updated on every pointer move will bloat the doc indefinitely.
- Long-lived documents with heavy key churn can hit real memory pressure on load (see [yjs#741](https://github.com/yjs/yjs/issues/741)).

Mitigations: keep ephemeral high-frequency state in Awareness (#12); for genuinely needed high-churn keys, consider a separate Y.Doc that can be rotated/rebuilt periodically.

### 17. Prefer Subdocuments Over Managing Multiple Root Y.Docs (MEDIUM)

When you need the permission-split pattern from #11, **subdocuments** are a first-class Yjs feature: embed a `Y.Doc` inside a shared type in a parent doc. Subdocuments have GUID-based identity, are lazily loaded by default (`autoLoad: false`), and can be managed by providers as part of the parent doc's sync lifecycle.

```typescript
const rootDoc = new Y.Doc();
const pageDoc = new Y.Doc(); // subdocument
rootDoc.getMap("pages").set("page-1", pageDoc);
pageDoc.load(); // lazy-load on demand
```

Subdocuments are cleaner than juggling two independent top-level docs when the lifecycle is "parent-known."

### 18. Top-Level Shared Types Can't Be Deleted (MEDIUM)

`ydoc.getMap("foo")` creates a root-level type that lives forever — you can `clear()` its contents, but the type itself can't be removed. This nudges a common pattern:

```typescript
// Fewer root types → more control over deletion
const data = ydoc.getMap("data");
data.set("page-1", yPageMap);
data.delete("page-1"); // sub-entries CAN be deleted
```

Keep a single root `getMap("data")` (or a handful of well-known roots like `data`, `schema`, `meta`) and nest everything else under it, so you can prune arbitrary subtrees later.

## Anti-Patterns to Avoid

1. **JSON blobs in a single value** — destroys granular merging.
2. **`Y.Array<Object>`** for concurrently edited collections — use `Y.Map<id, ...>`.
3. **Assuming "last write wins" means "latest timestamp"** — Yjs uses higher `clientID` wins. Use single-writer keys (e.g. `ymap.set(ydoc.clientID, value)`) or an external timestamp-based LWW layer for counters/presence.
4. **`Y.Array` for user-reorderable lists** — moves are delete+insert and lose concurrent edits. Use `Y.Map<id, ...>` with fractional-index ordering.
5. **Integer `index` fields for ordering** — two users reordering simultaneously produce duplicate indices. Use fractional indexing.
6. **Redundant keys** (storing `id` as a field when it's already the map key).
7. **Per-field writes outside a transaction** — wastes sync messages, leaks half-updated state to observers.
8. **Nested Y.Maps** for atomically-updated 2-field objects — flatten instead.
9. **Deleting a field to revert to default** — just write the default value (both delete and set leave tombstones, and delete is extra churn).
10. **One Y.Doc across permission boundaries** — you can't enforce authz inside a doc; any synced client reads and writes everything.
11. **Ephemeral state in the Y.Doc** — cursors, selections, presence belong in Awareness.
12. **Read-modify-write on shared counters** — Y.Map's LWW-by-`clientID` drops concurrent increments. Use single-writer keys.
13. **Mutating objects returned from `ymap.get()`** — Yjs doesn't clone; mutations silently diverge.
14. **Trying to move a shared type between parents** — copy-and-delete loses concurrent edits and breaks references.
15. **High-churn fields on Y.Map** — tombstones accumulate forever. Use Awareness or a rotatable Y.Doc.
16. **Sprawling root-level types** — you can't delete them. Nest under a single root map.

## Guidelines

### Schema Design (`rules/schema-design.md`)
- Y.Doc as hard format — design for growth
- Maps keyed by ID for collections
- Flat typed values over nested structures
- Derive, don't duplicate
- Split docs across permission boundaries; prefer subdocuments
- Shared types can't be moved once inserted
- Top-level shared types can't be deleted
- Don't mutate JSON retrieved from a shared type

### Concurrency Patterns (`rules/concurrency.md`)
- Group by how fields change together
- `Array<Object>` → `Map<id, Object>` with fractional indexing
- Known string sets → numbers
- `Y.Text` only for collaboratively typed strings
- Awareness for ephemeral state (cursors, selections, presence)
- Single-writer keys for counters and tallies

### Write Optimization (`rules/optimization.md`)
- Batch related writes in transactions
- Flatten small fixed-shape objects into encoded strings
- Skip default values on initial write
- Don't delete a field just because it returned to default
- Tombstones on Y.Map keys are forever — avoid high-churn fields in the doc

References:
- [Y.js documentation](https://docs.yjs.dev)
