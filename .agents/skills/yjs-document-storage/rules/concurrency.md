---
title: Concurrency-Safe Y.js Patterns
impact: CRITICAL
tags: yjs, concurrency, ymap, yarray, ytext, fractional-indexing
---

## Concurrency-Safe Y.js Patterns

**Impact: CRITICAL**

When deciding how granular your Y.js structure should be, the key question is:

> **"Will two users ever edit these values at the same time — and what do we want to happen?"**

Yjs's merge behavior is **different for each shared type**. Knowing which type gives you which semantics is the core of getting concurrent editing right.

### Y.Map Values: Last-Writer-Wins by `clientID` (not timestamp)

Per the Yjs internals: _"Maps are lists of entries. The last inserted entry for each key is used, and all other duplicates for each key are flagged as deleted."_

When two clients concurrently write different values to the **same key**, Yjs deterministically picks one to win — the client with the **higher `clientID`**, not the later wall-clock timestamp. This matters:

- Concurrent writes **do not merge character-by-character**. `ymap.set("role", "editor")` vs. a concurrent `ymap.set("role", "reader")` resolves to one of those two values atomically, never something like `"readitor"`.
- LWW-by-clientID is deterministic but **not intuitive**: a later edit on the lower-`clientID` peer can lose to an earlier edit on the higher-`clientID` peer.
- **Counters and other read-modify-write patterns silently lose writes.** If both clients read `5`, both write `6`, one write is discarded. Use per-client keys (`ymap.set(ydoc.clientID, value)`) and sum on read, or use a dedicated LWW-with-timestamp library.

> `Y.Text` is the exception — it uses a character-level CRDT that _does_ merge concurrent keystrokes. See below.

### Group Values by How They Change, Not by What They Describe

- **Always change together** (e.g. `updatedBy` + `updatedAt`): store as a single atomic value. Splitting them into separate Y.Map entries adds CRDT overhead without concurrent-edit benefit, and observers can fire with a `updatedBy` that doesn't match the current `updatedAt`.
- **Can change independently** (e.g. a document's `title` and its `status`): store as separate entries so concurrent edits to one don't overwrite the other.
- **User-editable text** (e.g. a title a user types into): use `Y.Text` for character-level merging.
- **Value selected from a set** (e.g. a dropdown): use a plain value that overwrites atomically (LWW-by-clientID).

Match Y.js granularity to how your UI actually works.

```typescript
// These always change together — combine into one value
yDoc.set("lastUpdate", `${userId}|${Date.now()}`);
// Read: const [updatedBy, updatedAt] = value.split("|");

// These change independently — keep separate
yDoc.set("name", new Y.Text()); // user types into this
yDoc.set("role", 0); // user selects from dropdown
yDoc.set("archived", true); // user toggles a checkbox
```

### `Array<Object>` → `Map<id, Object>`

`Y.Array` is correct for append-only sequences (logs, chat messages). For user-editable collections, it has four real problems:

1. **"Move" is actually delete + insert.** Once a shared type is inserted into a document it cannot be relocated. A UI-level reorder must delete the original item and insert a new one. Concurrent edits to the "moved" original are lost because the original item is gone.
2. **Reorder collisions produce duplicates.** Two clients dragging the same item to different positions delete once and insert twice — the item now appears in two places and Yjs can't tell it's the same thing.
3. **Index-based references are unstable.** "The item at index 3" changes meaning whenever anyone inserts at a lower index.
4. **Range-insert interleaving.** Two clients inserting ranges at the same position can produce interleaved output.

Use `Y.Map<id, Y.Map<field, value>>` so each entity has a stable ID, and concurrent edits to _different_ entities never collide.

```typescript
// Bad: Y.Array for a user-editable collection — moves lose data, reorders duplicate
const yDocuments = new Y.Array<DocumentJSON>();

// Good: Y.Map keyed by id — each document is independently editable, reorders are property updates
const yDocuments = new Y.Map<string, Y.Map<string, any>>();
// yDocuments.set(doc.id, yDocMap)
```

### Ordering: Use Fractional Indexing, Not Integer Positions

If the collection has user-controlled order, don't store `index: 0, 1, 2, ...` — two users reordering concurrently will produce colliding indices, and you can never cleanly insert between two items that share an index.

**Fractional indexing** assigns each item a sortable string (or rational-number) index such that there's always a valid value between any two neighbors:

```typescript
// Good: fractional index — always room to insert between any two items
yItem.set("index", "a0");
yItem.set("index", "a1");
// Insert between "a0" and "a1" → "a0m", no collision

// Read: [...yMap.values()].sort((a, b) => a.get("index").localeCompare(b.get("index")))
```

Use a library like [`fractional-indexing`](https://github.com/rocicorp/fractional-indexing) for this. Even then, two users inserting at the exact same boundary can tie — resolve by appending the `clientID` as a tiebreaker.

### Known Set of Strings → Number

When a field is an enum — a known, finite set like `"editor" | "reader"` or `"table" | "kanban"` — prefer a numeric code to the string label.

Concurrent writes don't corrupt either form (both are LWW-by-clientID on Y.Map, not character-merged). The reasons are:

- **Smaller encoding** in the Yjs binary format.
- **Cheap to rename labels** without touching documents.
- **Intent:** numeric code signals "this is a selection, not typed text" — matches the `Y.Text` vs. plain-value split in the next section.

```typescript
// OK: string enum — correct but larger and label-coupled
yMap.set("role", "editor");

// Better: numeric enum — compact, label-independent
const ROLES = ["editor", "reader"] as const;
yMap.set("role", 0);
// Read: ROLES[yMap.get("role")] → "editor"
```

### `Y.Text` Only for Collaboratively Edited Strings

`Y.Text` uses a character-level CRDT that merges concurrent keystrokes into a single readable result. Use it where two users might realistically type at the same time — a document title, a paragraph of prose.

For strings that are swapped wholesale — dropdown selections, enum labels — use a plain value. `Y.Text` for these is overkill (unused CRDT metadata per character) and wrong (`Y.Text` can't cleanly "replace" — it appends/deletes, producing odd histories and diffs).

```typescript
// Document title — users may type simultaneously
const yTitle = new Y.Text();
yTitle.insert(0, "My Document");
yDoc.set("title", yTitle);

// View type — user picks from a dropdown, no concurrent typing
yView.set("type", 0); // 0 = "table"
```

### Awareness, Not the Y.Doc, for Ephemeral State

Cursor positions, text selections, typing indicators, "who's viewing," hover state — this kind of per-session signal should live in the **Awareness** protocol, not the Y.Doc.

Awareness is a separate channel that Yjs providers expose alongside document sync:

- **Ephemeral:** state exists only while a client is connected, and auto-cleans when the client disconnects.
- **Per-client state:** Awareness maps `clientID → state`, so each client writes its own slot — no concurrent-write conflicts on the same key.
- **Not persisted:** Awareness doesn't go into the Y.Doc's update stream or history.

```typescript
// Good: cursor in Awareness
provider.awareness.setLocalStateField("cursor", { x, y, selection });

// Read other users' cursors
for (const [clientID, state] of provider.awareness.getStates()) {
  renderRemoteCursor(clientID, state.cursor);
}
```

Putting ephemeral state in the Y.Doc has three real costs: history pollution (every cursor move is a permanent edit), **tombstone accumulation** (see `optimization.md` on Y.Map tombstones), and sync amplification (every move syncs to every peer forever, not just currently-connected ones).

Rule of thumb: if the state should disappear when the tab closes, it belongs in Awareness.

### Single-Writer Keys for Counters and Shared Tallies

Because Y.Map is last-writer-wins by `clientID`, **read-modify-write loses writes** under concurrency:

```typescript
// Bad: concurrent increments silently drop one
ymap.set("count", (ymap.get("count") ?? 0) + 1);
// Both clients read 5, both write 6, one increment is lost
```

The fix is to give each client its own sub-key and aggregate on read:

```typescript
// Good: each client writes only to its own slot
const counts = ymap.get("counts") as Y.Map<number>;
const myKey = String(ydoc.clientID);
counts.set(myKey, (counts.get(myKey) ?? 0) + 1);

// Read: sum across all clients
const total = [...counts.values()].reduce((a, b) => a + b, 0);
```

Apply this to:

- **View/reaction counters** — each client tallies its own contribution.
- **"Who's in this room" sets** — each client writes its presence to `clientID`, others read the map.
- **Per-client state that shouldn't overwrite other clients** — settings, drafts, saved positions.

For counters that need to survive disconnects but still need proper last-write-wins semantics (e.g. across multiple sessions of the same user), use an external library like [`y-lwwmap`](https://github.com/rozek/y-lwwmap) that attaches explicit timestamps.

### Match Granularity to the Editing Surface

Not every field needs a CRDT entry of its own:

- **UI-editable fields** (filters, column widths, sort orders) → decomposed `Y.Map` / `Y.Array` for concurrent safety.
- **Write-once metadata** (`createdAt`, `createdBy`) → a plain value is fine.
- **Small, rarely-edited data** (enum option lists) → a JSON string is acceptable.

```typescript
// Filters: users edit via UI → use Y.Map for concurrent safety
const yFilters = new Y.Map<string, Y.Map<string, any>>();

// Enum options: rarely edited, small → JSON string is fine
ySchema.set("enum", JSON.stringify(enumOptions));

// createdAt: set once, never edited → plain value
yDoc.set("createdAt", Date.now());
```
