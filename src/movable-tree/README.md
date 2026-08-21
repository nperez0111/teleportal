# `teleportal/movable-tree`

A cycle-free movable tree CRDT on a Y.Doc, implementing Kleppmann, Mulligan,
Beresford & Gomes, ["A highly-available move operation for replicated
trees"](https://martin.kleppmann.com/papers/move-op.pdf).

## Why it exists

A tree with a `move` operation is the natural model for a file system: one
Y.Doc holds the hierarchy, node ids point at sub-documents holding file
content. But `move` is famously unsafe to replicate naively. If each node's
parent lives in a Y.Map, two replicas can concurrently perform moves that are
each individually valid — `move A under B` on one, `move B under A` on the
other — and Y.js will happily converge both replicas to the same state: a
cycle detached from the root. The data is "consistent" and the tree is
destroyed. (The first test in `movable-tree.test.ts` demonstrates exactly
this as a negative control.)

The move-op paper solves this with an operation log instead of mutable state,
and proves (in Isabelle/HOL) that the result converges and is always a tree:
no cycles, no duplicated nodes, no lost nodes. This package is a faithful
implementation of that algorithm with the log stored in a Y.Array.

## How it works

The shared state is a **grow-only set of move operations** in a Y.Array; the
tree itself is derived local state, never shared. Every mutation — create,
move, rename, delete — is exactly one operation:

```
Move(counter, replicaId, child, parent, meta)
```

`(counter, replicaId)` is a Lamport timestamp giving a total order over all
operations. Each replica keeps its log sorted in that order and materializes
the tree by applying ops in log order, where `do_op`:

- records the child's previous parent (for undo), then
- **ignores** the op (tree unchanged, log entry kept) if the child is a
  pseudo-root, or if the child is the new parent or an ancestor of it — the
  cycle check, evaluated against the tree state _at that point in the log_ —
- otherwise reparents the child.

When an op arrives whose timestamp is older than the newest log entry, later
entries are undone, the op is inserted in place, and the later entries are
redone (recomputing their previous-parent records and ignored verdicts). The
final tree therefore depends only on the _set_ of ops, not their delivery
order — which is precisely what Y.js guarantees about the Y.Array. Concurrent
cycle-creating moves resolve identically everywhere: the op ordered first
wins, the other becomes a recorded no-op on every replica.

Notable consequences, all covered by tests:

- **Creation is a move** of a never-seen id; there is no separate create op.
- **Deletion is a move to the `TRASH` pseudo-root.** The subtree rides along
  and can be restored by moving it back out.
- **Renames (meta updates) are moves to the same parent** carrying new meta,
  so concurrent renames are last-writer-wins by timestamp.
- Applying the same update twice, replaying the whole doc, or receiving ops
  in any interleaving is idempotent (a local seen-set keyed by
  `replicaId:counter`).

## Usage

```ts
import * as Y from "yjs";
import { MovableTree } from "teleportal/movable-tree";

const doc = new Y.Doc();
const tree = new MovableTree<{ name: string }>(doc);

const docs = tree.root.createChild({ name: "docs" });
// Pass a subdocument GUID as the node id to point files at Y.js subdocs:
const readme = docs.createChild({ name: "readme.md" }, subdoc.guid);

readme.moveTo(tree.root);
readme.setMeta({ name: "README.md" });
readme.delete(); // moves to tree.trash — restorable
readme.restore(docs);

docs.children; // TreeNode[] — unordered; sort by meta in the UI
readme.path; // [root, docs, readme]
tree.onChange(() => render(tree.toJSON()));
```

`TreeNode` handles are interned per tree, so identity holds
(`node.children[0].parent === node`) and handles remain valid across moves.

Ops are stored as fixed-position tuples `[counter, replicaId, child, parent,
meta]` rather than keyed objects: the log is grow-only, and Y.js repeats
object keys in every element while tuples carry no key overhead. Treat `meta`
values as immutable — replace them via `setMeta`, never mutate in place.

`replicaId` defaults to `doc.clientID` and must be unique per
concurrently-active `MovableTree` instance; two live instances sharing a
replicaId can mint colliding op ids. A session-scoped id is safe: ops keep
their original id forever, and the id only affects tie-breaking between
concurrent ops.

## Growth and garbage collection

The op log is append-only, and Y.js GC only reclaims _deleted_ items — so
nothing in the tree doc is ever GC'd and it grows with the total number of
operations. In practice this is small: tuple-encoded ops are a few dozen
bytes, Y.js merges adjacent same-client items in encoded updates, and file
_content_ lives in sub-documents, so the tree doc only grows at the human
rate of structural changes.

The principled fix is the paper's §4 log truncation: once an op is _causally
stable_ (every replica has seen it), it can never be undone or redone, so the
stable prefix can be deleted from the Y.Array — at which point Y.js GC
collapses it into merged tombstones. That requires knowing the replica set
(e.g. server-tracked acks or a vector clock, as in
[udr-tree](https://github.com/joaquin30/udr-tree)), and is future work.

## Future work

- **Log truncation under causal stability** (above).
- **Sibling ordering.** The paper's tree is unordered and so is this one —
  `children` comes back in no particular order and a file UI should sort by
  name. If explicit ordering is ever needed, a fractional-index field in
  `meta` (updated via `setMeta`) slots in without touching the algorithm.
- **Binary op encoding.** Tuples-in-ContentAny are compact but a hand-rolled
  lib0 encoding would be smaller still.
