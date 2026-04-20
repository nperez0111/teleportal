---
title: Schema Design for Y.Docs
impact: CRITICAL
tags: yjs, schema, structure, permissions
---

## Schema Design for Y.Docs

**Impact: CRITICAL**

A Y.js document is the **source of truth** for your data. Once clients are syncing against a particular structure, changing that structure is a migration — not a refactor. Treat your Y.Doc layout the way you'd treat a database schema or wire protocol: it needs to be **correct now** and **extendable later**.

Design for your domain's growth axes. Think about what entities will be added, what fields will appear on existing entities, and what relationships might form. Choose structures that allow these additions without breaking existing documents.

### Maps Keyed by ID for Collections

Adding a new entity is just a new key — no migration needed.

```typescript
// Bad: entire collection as one JSON blob — adding a field means rewriting everything
yMap.set("schema", JSON.stringify(fullSchemaObject));

// Good: each property is its own entry — adding a new property is just a new key
const ySchema = doc.getMap("schema");
ySchema.set(propertyId, yPropertyMap); // each property independently editable
```

### Reserve Top-Level Keys for Major Concepts

Use top-level keys like `"documents"`, `"schema"`, `"views"` for the major concepts of your domain. Avoid polluting the root namespace with fields that belong inside a nested entity.

### Prefer Flat Typed Values

Flat maps are easier to extend with new fields than nested objects that must be versioned as a whole.

### Never Serialize Entire Objects as JSON Strings

Serializing whole objects as one Y.js value defeats the purpose of using a CRDT:

- You lose granular merging.
- Any concurrent edit to any field inside the blob conflicts with every other edit.
- Adding a field requires rewriting the whole blob.

Small, rarely-edited data (e.g. enum option lists) is the only acceptable exception — see `optimization.md` on defaults and `concurrency.md` on editing surface.

### If You Can Derive It, Don't Store It

Remove fields that can be inferred from structure:

- **ID as map key** — don't also store `id` inside the map value.
- **Parent context** — a document inside a collection's `documents` map doesn't need `collectionId`.
- **Computable values** — don't store `size` when it equals `documents.size`.

```typescript
// Bad: redundant data
yDocuments.set(doc.id, { id: doc.id, collectionId: collection.id, ... });

// Good: derive id from key, collectionId from parent
yDocuments.set(doc.id, { /* id and collectionId omitted */ ... });
// Read: hydrateDocument(docId, collectionId, yMap)
```

### Split Across Y.Docs When Permissions Differ

**Permissions cannot be enforced within a single Y.Doc.** Any client that can sync the doc can read and write everything in it. If different parts of your data need different access levels, split them into separate Y.Docs.

A common pattern: one **index Y.Doc** holding only ID references and lightweight metadata, and one **Y.Doc per entity** for the actual content.

```typescript
// Index doc — all workspace members sync this
const indexDoc = new Y.Doc();
const yPages = indexDoc.getMap("pages"); // { pageId → { title, icon, ... } }

// Per-page doc — only users with page access sync this
const pageDoc = new Y.Doc();
const yContent = pageDoc.getMap("content"); // full page content
```

**When to split:**

- Different entities have different read/write permissions (shared index vs. private pages).
- You need to revoke access to specific entities without affecting others.
- Entity data is large and not all clients need all of it (lazy-loading).

**When NOT to split:**

- All users have the same permissions across all data — one Y.Doc is simpler.
- The overhead of managing multiple docs and their sync lifecycle isn't justified.

### Prefer Subdocuments Over Multiple Root Y.Docs

When the split lifecycle is **parent-known** (i.e. the parent doc can reference the children), use Yjs **subdocuments** rather than juggling independent top-level `Y.Doc` instances. A subdocument is a `Y.Doc` embedded inside a shared type in a parent doc:

```typescript
const rootDoc = new Y.Doc();
const pageDoc = new Y.Doc();            // subdocument
rootDoc.getMap("pages").set("page-1", pageDoc);

// Subdocuments are NOT auto-loaded by default — call .load() when needed
pageDoc.load();
```

Benefits:

- **GUID-based identity.** Every `Y.Doc` gets a `doc.guid`; providers sync by GUID, so a subdocument can appear in multiple places or be rehydrated against the same remote state.
- **Lazy loading.** Subdocuments start empty and only sync content after `.load()` (or set `new Y.Doc({ autoLoad: true })` to load eagerly).
- **Unified provider lifecycle.** A provider that understands subdocuments can sync the collection through one connection rather than N separate providers.

Subdocuments don't solve permissions by themselves — you still need a provider/backend that enforces access per-GUID — but they give you a clean structural home for the split.

### Shared Types Can't Be Moved Once Inserted

A `Y.Map`, `Y.Array`, or `Y.Text` is bound to its parent forever. You cannot relocate a shared type from one container to another.

```typescript
// This throws — can't move a shared type
yarray.insert(0, [ymap.get("my other array") as Y.Array]);
```

"Moving" is physically a copy-and-delete, with two real consequences:

- The destination gets a **new** shared-type instance; any concurrent edits on the original (now-deleted) one are lost.
- External references to the original shared type become detached.

**Design implication:** if entities logically move between containers, don't nest the shared type inside the container — instead keep shared types in a flat top-level map and reference them by ID from container-level indexes:

```typescript
// Good: flat storage, containers hold IDs not shared types
const yPages = ydoc.getMap("pages");          // pageId → Y.Map(page content)
const yFolders = ydoc.getMap("folders");      // folderId → Y.Map({ pageIds: Y.Array<string> })

// "Moving" a page between folders is just updating ID lists — the page Y.Map never moves
```

### Top-Level Shared Types Can't Be Deleted

`ydoc.getMap("foo")` creates a root-level type. You can `.clear()` its contents, but the type itself lives for the life of the Y.Doc. A doc with many root-level keys accumulates them permanently.

**Pattern:** keep a single (or small, fixed set of) root-level map(s) and nest everything else beneath them. Sub-entries in a nested map **can** be deleted.

```typescript
// Bad: every entity is a root-level type — none can ever be deleted
ydoc.getMap("page-1");
ydoc.getMap("page-2");
ydoc.getMap("page-3");

// Good: one root, deletable children
const data = ydoc.getMap("data");
data.set("page-1", yPage1);
data.delete("page-1"); // ✓ works
```

### Don't Mutate JSON Retrieved From a Shared Type

Yjs does **not** clone values passed to `set` or returned from `get`. The same JS object lives in both your local variable and the internal Y.Map state. Mutating it:

- Does **not** fire an observer or produce a sync update.
- Produces silent divergence — your local copy changes, remote peers never see it.

```typescript
// Bad: mutates in place — Yjs doesn't notice, remote peers never see the change
const meta = ymap.get("meta");
meta.foo = "bar";

// Good: derive a new value and set it back
ymap.set("meta", { ...ymap.get("meta"), foo: "bar" });
```

For values that need per-field granular updates, don't store them as JSON at all — use a nested `Y.Map`.

