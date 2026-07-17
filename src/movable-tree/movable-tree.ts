import type * as Y from "yjs";

/** Id of the visible tree root. Always a valid parent, never a valid child. */
export const ROOT = "__root__";
/** Id of the trash pseudo-root. Deleting a node moves it (and its subtree) here. */
export const TRASH = "__trash__";

/**
 * Wire form of a move operation, stored in the Y.Array. A fixed-position tuple
 * (not a keyed object) because the log is grow-only: Y.js ContentAny repeats
 * object key strings in every element, tuples avoid that overhead entirely.
 */
export type EncodedOp<TMeta> = [
  counter: number,
  replicaId: number,
  child: string,
  parent: string,
  meta: TMeta,
];

/** Decoded working form of a move operation. */
export interface MoveOp<TMeta> {
  counter: number;
  replicaId: number;
  child: string;
  parent: string;
  meta: TMeta;
}

export interface TreeSnapshot<TMeta> {
  id: string;
  meta: TMeta | undefined;
  children: TreeSnapshot<TMeta>[];
}

export interface MovableTreeOptions {
  /** Name of the Y.Array holding the op log. Defaults to `"movable-tree"`. */
  typeName?: string;
  /**
   * Lamport tie-break id. Defaults to `doc.clientID`. Must be unique per
   * concurrently-active MovableTree instance — two live instances sharing a
   * replicaId can mint colliding op ids.
   */
  replicaId?: number;
  /** Node id factory used when `createChild` is called without an id. */
  generateId?: () => string;
}

type Edge<TMeta> = { parent: string; meta: TMeta };

/**
 * The paper's LogMove record. `oldParent` is local-only state, recomputed at
 * do/redo time (undefined = the child did not exist before this op). `ignored`
 * marks ops that left the tree unchanged (cycle / pseudo-node moves), making
 * their undo free; a later out-of-order insertion can flip the verdict on redo.
 */
type LogEntry<TMeta> = {
  op: MoveOp<TMeta>;
  oldParent: Edge<TMeta> | undefined;
  ignored: boolean;
};

/** Internal accessors handed to TreeNode handles. */
type TreeInternals<TMeta> = {
  edge: (id: string) => Edge<TMeta> | undefined;
  childIds: (id: string) => ReadonlySet<string> | undefined;
  emitOp: (child: string, parent: string, meta: TMeta) => void;
  handle: (id: string) => TreeNode<TMeta>;
  generateId: () => string;
};

const compareOps = <TMeta>(a: MoveOp<TMeta>, b: MoveOp<TMeta>): number =>
  a.counter - b.counter || a.replicaId - b.replicaId;

const decodeOp = <TMeta>(enc: EncodedOp<TMeta>): MoveOp<TMeta> => ({
  counter: enc[0],
  replicaId: enc[1],
  child: enc[2],
  parent: enc[3],
  meta: enc[4],
});

/**
 * A movable tree CRDT on a Y.Doc, implementing Kleppmann et al.,
 * "A highly-available move operation for replicated trees".
 *
 * The shared state is a grow-only op *set* in a Y.Array; the tree itself is
 * derived local state, kept convergent by replaying ops in Lamport-timestamp
 * order via the paper's undo/do/redo scheme. Concurrent moves can never
 * produce a cycle: ops are applied in timestamp order and an op whose move
 * would create a cycle is recorded but ignored — identically on every replica.
 */
export class MovableTree<TMeta = Record<string, unknown>> {
  readonly root: TreeNode<TMeta>;
  readonly trash: TreeNode<TMeta>;

  #yarray: Y.Array<EncodedOp<TMeta>>;
  #log: LogEntry<TMeta>[] = [];
  #nodes = new Map<string, Edge<TMeta>>();
  #children = new Map<string, Set<string>>();
  #seen = new Set<string>();
  #maxCounter = 0;
  #replicaId: number;
  #handles = new Map<string, TreeNode<TMeta>>();
  #listeners = new Set<() => void>();
  #internals: TreeInternals<TMeta>;

  constructor(doc: Y.Doc, options: MovableTreeOptions = {}) {
    this.#replicaId = options.replicaId ?? doc.clientID;
    const generateId = options.generateId ?? (() => crypto.randomUUID());
    this.#yarray = doc.getArray(options.typeName ?? "movable-tree");
    this.#internals = {
      edge: (id) => this.#nodes.get(id),
      childIds: (id) => this.#children.get(id),
      emitOp: (child, parent, meta) => this.#emitOp(child, parent, meta),
      handle: (id) => this.#handle(id),
      generateId,
    };
    this.root = this.#handle(ROOT);
    this.trash = this.#handle(TRASH);
    this.#yarray.observe(this.#observer);
    this.#integrateBatch(this.#yarray.toArray());
  }

  getNode(id: string): TreeNode<TMeta> | undefined {
    return this.has(id) ? this.#handle(id) : undefined;
  }

  has(id: string): boolean {
    return id === ROOT || id === TRASH || this.#nodes.has(id);
  }

  /** Every known node (including trashed ones), excluding the pseudo-roots. */
  *nodes(): IterableIterator<TreeNode<TMeta>> {
    for (const id of this.#nodes.keys()) yield this.#handle(id);
  }

  /**
   * Subscribes to tree changes (one coalesced call per transaction that
   * changed the tree). Returns an unsubscribe function.
   */
  onChange(callback: () => void): () => void {
    this.#listeners.add(callback);
    return () => this.#listeners.delete(callback);
  }

  toJSON(): { root: TreeSnapshot<TMeta>; trash: TreeSnapshot<TMeta> } {
    return { root: this.root.toJSON(), trash: this.trash.toJSON() };
  }

  destroy(): void {
    this.#yarray.unobserve(this.#observer);
    this.#listeners.clear();
  }

  /** Total number of integrated ops (the log is grow-only). */
  get opCount(): number {
    return this.#log.length;
  }

  #handle(id: string): TreeNode<TMeta> {
    let handle = this.#handles.get(id);
    if (!handle) {
      handle = new TreeNode(this.#internals, id);
      this.#handles.set(id, handle);
    }
    return handle;
  }

  #emitOp(child: string, parent: string, meta: TMeta): void {
    // Bump the clock eagerly so several ops in one transaction (the observer
    // only fires at transaction end) still get distinct counters.
    this.#maxCounter += 1;
    const op: EncodedOp<TMeta> = [this.#maxCounter, this.#replicaId, child, parent, meta];
    this.#yarray.push([Object.freeze(op) as EncodedOp<TMeta>]);
  }

  #observer = (event: Y.YArrayEvent<EncodedOp<TMeta>>): void => {
    const inserted: EncodedOp<TMeta>[] = [];
    for (const delta of event.changes.delta) {
      if (delta.insert) inserted.push(...(delta.insert as EncodedOp<TMeta>[]));
    }
    if (this.#integrateBatch(inserted)) {
      for (const listener of this.#listeners) listener();
    }
  };

  #integrateBatch(encoded: EncodedOp<TMeta>[]): boolean {
    const ops = encoded.map(decodeOp);
    // Sorting the batch minimizes undo/redo churn; cross-batch ordering is
    // still handled by integrate itself.
    ops.sort(compareOps);
    let changed = false;
    for (const op of ops) changed = this.#integrate(op) || changed;
    return changed;
  }

  /**
   * The paper's apply_op: keeps the log sorted by timestamp, undoing and
   * redoing later entries when an op arrives out of order. Returns whether
   * the tree may have changed.
   */
  #integrate(op: MoveOp<TMeta>): boolean {
    const opId = `${op.replicaId}:${op.counter}`;
    if (this.#seen.has(opId)) return false;
    this.#seen.add(opId);
    if (op.counter > this.#maxCounter) this.#maxCounter = op.counter;

    const last = this.#log[this.#log.length - 1];
    if (!last || compareOps(op, last.op) > 0) {
      const entry = this.#doOp(op);
      this.#log.push(entry);
      return !entry.ignored;
    }

    let lo = 0;
    let hi = this.#log.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compareOps(this.#log[mid]!.op, op) < 0) lo = mid + 1;
      else hi = mid;
    }
    for (let i = this.#log.length - 1; i >= lo; i--) {
      this.#undoEntry(this.#log[i]!);
    }
    this.#log.splice(lo, 0, this.#doOp(op));
    for (let i = lo + 1; i < this.#log.length; i++) {
      const entry = this.#log[i]!;
      const fresh = this.#doOp(entry.op);
      entry.oldParent = fresh.oldParent;
      entry.ignored = fresh.ignored;
    }
    return true;
  }

  #doOp(op: MoveOp<TMeta>): LogEntry<TMeta> {
    const oldParent = this.#nodes.get(op.child);
    const ignored =
      op.child === ROOT || op.child === TRASH || this.#isAncestorOrSelf(op.child, op.parent);
    if (!ignored) {
      if (oldParent) this.#children.get(oldParent.parent)?.delete(op.child);
      this.#nodes.set(op.child, { parent: op.parent, meta: op.meta });
      this.#childSet(op.parent).add(op.child);
    }
    return { op, oldParent, ignored };
  }

  #undoEntry(entry: LogEntry<TMeta>): void {
    if (entry.ignored) return;
    this.#children.get(entry.op.parent)?.delete(entry.op.child);
    if (entry.oldParent === undefined) {
      this.#nodes.delete(entry.op.child);
    } else {
      this.#nodes.set(entry.op.child, entry.oldParent);
      this.#childSet(entry.oldParent.parent).add(entry.op.child);
    }
  }

  /** True if `ancestor` is `node` or an ancestor of `node`. O(depth). */
  #isAncestorOrSelf(ancestor: string, node: string): boolean {
    let cur: string | undefined = node;
    while (cur !== undefined) {
      if (cur === ancestor) return true;
      cur = this.#nodes.get(cur)?.parent;
    }
    return false;
  }

  #childSet(parent: string): Set<string> {
    let set = this.#children.get(parent);
    if (!set) {
      set = new Set();
      this.#children.set(parent, set);
    }
    return set;
  }
}

/**
 * A lightweight live handle onto a node of a {@link MovableTree}. Handles are
 * interned per tree, so identity holds: `node.children[0].parent === node`.
 * Handles stay valid across moves; a handle to a trashed node reports
 * `isDeleted`. Do not construct directly — obtain handles from the tree.
 */
export class TreeNode<TMeta> {
  readonly id: string;
  #tree: TreeInternals<TMeta>;

  constructor(tree: TreeInternals<TMeta>, id: string) {
    this.#tree = tree;
    this.id = id;
  }

  get meta(): TMeta | undefined {
    return this.#tree.edge(this.id)?.meta;
  }

  /**
   * Replaces this node's metadata. Per the paper, a meta update is a move to
   * the same parent carrying the new meta, so concurrent updates resolve
   * last-writer-wins by timestamp. Treat meta values as immutable.
   */
  setMeta(meta: TMeta): void {
    const edge = this.#edgeOrThrow("set meta on");
    this.#tree.emitOp(this.id, edge.parent, meta);
  }

  get parent(): TreeNode<TMeta> | undefined {
    const edge = this.#tree.edge(this.id);
    return edge && this.#tree.handle(edge.parent);
  }

  /** Unordered; sort in the caller (a file UI typically sorts by name). */
  get children(): TreeNode<TMeta>[] {
    const ids = this.#tree.childIds(this.id);
    return ids ? [...ids].map((id) => this.#tree.handle(id)) : [];
  }

  createChild(meta: TMeta, id?: string): TreeNode<TMeta> {
    const childId = id ?? this.#tree.generateId();
    if (childId === ROOT || childId === TRASH) {
      throw new Error(`cannot create a node with the reserved id ${childId}`);
    }
    if (this.#tree.edge(childId)) {
      throw new Error(`node ${childId} already exists`);
    }
    this.#tree.emitOp(childId, this.id, meta);
    return this.#tree.handle(childId);
  }

  moveTo(parent: TreeNode<TMeta>): void {
    const edge = this.#edgeOrThrow("move");
    this.#tree.emitOp(this.id, parent.id, edge.meta);
  }

  /** Moves this node (with its subtree) to the trash. Restorable. */
  delete(): void {
    const edge = this.#edgeOrThrow("delete");
    this.#tree.emitOp(this.id, TRASH, edge.meta);
  }

  /** Moves this node back out of the trash (to the root by default). */
  restore(to?: TreeNode<TMeta>): void {
    const edge = this.#edgeOrThrow("restore");
    this.#tree.emitOp(this.id, to?.id ?? ROOT, edge.meta);
  }

  /** True if this node is currently in the trash (directly or via an ancestor). */
  get isDeleted(): boolean {
    let cur: string | undefined = this.id;
    while (cur !== undefined) {
      if (cur === TRASH) return true;
      cur = this.#tree.edge(cur)?.parent;
    }
    return false;
  }

  /** Number of edges between this node and its pseudo-root. */
  get depth(): number {
    return this.path.length - 1;
  }

  /** The chain of nodes from the pseudo-root down to (and including) this node. */
  get path(): TreeNode<TMeta>[] {
    const path: TreeNode<TMeta>[] = [this as TreeNode<TMeta>];
    for (const ancestor of this.ancestors()) path.push(ancestor);
    return path.reverse();
  }

  /** True if this node is a strict ancestor of `other`. */
  isAncestorOf(other: TreeNode<TMeta>): boolean {
    for (const ancestor of other.ancestors()) {
      if (ancestor.id === this.id) return true;
    }
    return false;
  }

  /** True if this node is a strict descendant of `other`. */
  isDescendantOf(other: TreeNode<TMeta>): boolean {
    return other.isAncestorOf(this as TreeNode<TMeta>);
  }

  /** Walks parent-up from this node (excluding it). */
  *ancestors(): IterableIterator<TreeNode<TMeta>> {
    let cur = this.#tree.edge(this.id)?.parent;
    while (cur !== undefined) {
      yield this.#tree.handle(cur);
      cur = this.#tree.edge(cur)?.parent;
    }
  }

  /** Depth-first walk of this node's subtree (excluding it). */
  *descendants(): IterableIterator<TreeNode<TMeta>> {
    const stack = [...(this.#tree.childIds(this.id) ?? [])];
    while (stack.length > 0) {
      const id = stack.pop()!;
      yield this.#tree.handle(id);
      const childIds = this.#tree.childIds(id);
      if (childIds) stack.push(...childIds);
    }
  }

  /** Subtree snapshot. Children are sorted by id so snapshots deep-equal across replicas. */
  toJSON(): TreeSnapshot<TMeta> {
    return {
      id: this.id,
      meta: this.meta,
      children: this.children
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((child) => child.toJSON()),
    };
  }

  #edgeOrThrow(action: string): Edge<TMeta> {
    if (this.id === ROOT || this.id === TRASH) {
      throw new Error(`cannot ${action} the ${this.id} pseudo-node`);
    }
    const edge = this.#tree.edge(this.id);
    if (!edge) throw new Error(`cannot ${action} unknown node ${this.id}`);
    return edge;
  }
}
