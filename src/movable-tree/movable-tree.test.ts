import { describe, expect, it } from "bun:test";
import * as prng from "lib0/prng";
import * as Y from "yjs";
import { type EncodedOp, MovableTree, ROOT, TRASH, type TreeNode } from "./movable-tree";

const syncBothWays = (a: Y.Doc, b: Y.Doc) => {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
};

/**
 * Walks parent pointers from `start`, returning true if the walk revisits a
 * node (i.e. the "tree" contains a cycle).
 */
const hasCycle = (parents: Map<string, string>, start: string): boolean => {
  const visited = new Set<string>();
  let cur: string | undefined = start;
  while (cur !== undefined) {
    if (visited.has(cur)) return true;
    visited.add(cur);
    cur = parents.get(cur);
  }
  return false;
};

type Meta = { name: string };

const makeTrees = (count: number): { docs: Y.Doc[]; trees: MovableTree<Meta>[] } => {
  const docs: Y.Doc[] = [];
  const trees: MovableTree<Meta>[] = [];
  for (let i = 0; i < count; i++) {
    const doc = new Y.Doc();
    doc.clientID = i + 1;
    docs.push(doc);
    trees.push(new MovableTree<Meta>(doc, { replicaId: i + 1 }));
  }
  return { docs, trees };
};

/**
 * Asserts the movable-tree invariants on a replica: every node's parent walk
 * terminates at a pseudo-root without revisiting a node (acyclic +
 * reachability), and the children index agrees with the parent pointers.
 */
const expectTreeInvariants = (tree: MovableTree<Meta>) => {
  for (const node of tree.nodes()) {
    const visited = new Set<string>();
    let cur: TreeNode<Meta> | undefined = node;
    while (cur !== undefined && cur.id !== ROOT && cur.id !== TRASH) {
      expect(visited.has(cur.id)).toBe(false);
      visited.add(cur.id);
      cur = cur.parent;
    }
    expect(cur).toBeDefined(); // terminated at ROOT or TRASH, not an orphan
    const parent = node.parent!;
    expect(parent.children.some((child) => child === node)).toBe(true);
  }
};

describe("naive Y.Map parent-pointer tree (negative control)", () => {
  it("converges to a cycle under concurrent conflicting moves", () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    docA.getMap<string>("tree").set("A", "root");
    docA.getMap<string>("tree").set("B", "root");
    syncBothWays(docA, docB);

    // Offline, each doc makes a move that is individually valid:
    docA.getMap<string>("tree").set("A", "B");
    docB.getMap<string>("tree").set("B", "A");
    syncBothWays(docA, docB);

    // Both replicas converge (Y.js guarantees that much)...
    expect(docA.getMap("tree").toJSON()).toEqual(docB.getMap("tree").toJSON());

    // ...but the converged state is not a tree: A -> B -> A.
    const parents = new Map(Object.entries(docA.getMap<string>("tree").toJSON()));
    expect(hasCycle(parents, "A")).toBe(true);
  });
});

describe("MovableTree basics", () => {
  it("builds a tree with handle identity, paths, and traversal", () => {
    const { docs, trees } = makeTrees(2);
    const [treeA, treeB] = trees as [MovableTree<Meta>, MovableTree<Meta>];

    const docsDir = treeA.root.createChild({ name: "docs" }, "docs");
    const readme = docsDir.createChild({ name: "readme.md" }, "readme");

    expect(readme.meta).toEqual({ name: "readme.md" });
    expect(readme.parent).toBe(docsDir); // interned handles: identity holds
    expect(docsDir.children).toEqual([readme]);
    expect(treeA.root.children).toEqual([docsDir]);
    expect(readme.path.map((node) => node.id)).toEqual([ROOT, "docs", "readme"]);
    expect(readme.depth).toBe(2);
    expect([...readme.ancestors()].map((node) => node.id)).toEqual(["docs", ROOT]);
    expect([...treeA.root.descendants()].map((node) => node.id).sort()).toEqual(["docs", "readme"]);
    expect(treeA.getNode("readme")).toBe(readme);
    expect(treeA.getNode("missing")).toBeUndefined();
    expect(treeA.has("docs")).toBe(true);

    // A child created without an id gets a generated one.
    const generated = treeA.root.createChild({ name: "auto" });
    expect(generated.id.length).toBeGreaterThan(0);

    syncBothWays(docs[0]!, docs[1]!);
    expect(treeB.toJSON()).toEqual(treeA.toJSON());
    expect(treeB.getNode("readme")!.parent!.id).toBe("docs");
  });

  it("creating a node with an existing or reserved id throws", () => {
    const { trees } = makeTrees(1);
    const tree = trees[0]!;
    tree.root.createChild({ name: "a" }, "a");
    expect(() => tree.root.createChild({ name: "a2" }, "a")).toThrow("already exists");
    expect(() => tree.root.createChild({ name: "r" }, ROOT)).toThrow("reserved");
    expect(() => tree.root.createChild({ name: "t" }, TRASH)).toThrow("reserved");
  });

  it("emits one coalesced change event per changing transaction", () => {
    const { docs, trees } = makeTrees(2);
    const treeA = trees[0]!;
    const treeB = trees[1]!;
    let changesA = 0;
    let changesB = 0;
    treeA.onChange(() => changesA++);
    const unsubscribeB = treeB.onChange(() => changesB++);

    treeA.root.createChild({ name: "a" }, "a");
    expect(changesA).toBe(1); // observers fire synchronously

    docs[0]!.transact(() => {
      treeA.root.createChild({ name: "b" }, "b");
      treeA.root.createChild({ name: "c" }, "c");
    });
    expect(changesA).toBe(2); // coalesced across the transaction

    Y.applyUpdate(docs[1]!, Y.encodeStateAsUpdate(docs[0]!));
    expect(changesB).toBe(1);

    unsubscribeB();
    treeA.root.createChild({ name: "d" }, "d");
    Y.applyUpdate(docs[1]!, Y.encodeStateAsUpdate(docs[0]!));
    expect(changesB).toBe(1); // unsubscribed

    treeA.destroy();
    treeB.destroy();
  });
});

describe("MovableTree ignored operations", () => {
  it("move-to-self is recorded but leaves the tree unchanged", () => {
    const { docs, trees } = makeTrees(2);
    const treeA = trees[0]!;
    const a = treeA.root.createChild({ name: "a" }, "a");
    syncBothWays(docs[0]!, docs[1]!);
    const before = treeA.toJSON();

    a.moveTo(a);
    expect(treeA.toJSON()).toEqual(before);
    expect(treeA.opCount).toBe(2); // the op is still in the log

    syncBothWays(docs[0]!, docs[1]!);
    expect(trees[1]!.toJSON()).toEqual(before);
    expect(trees[1]!.opCount).toBe(2);
  });

  it("root and trash cannot be moved locally, and crafted remote ops are ignored", () => {
    const { docs, trees } = makeTrees(2);
    const treeA = trees[0]!;
    const a = treeA.root.createChild({ name: "a" }, "a");
    expect(() => treeA.root.moveTo(a)).toThrow("pseudo-node");
    expect(() => treeA.trash.moveTo(a)).toThrow("pseudo-node");
    expect(() => treeA.root.delete()).toThrow("pseudo-node");
    syncBothWays(docs[0]!, docs[1]!);
    const before = treeA.toJSON();

    // A malicious/buggy peer appends ops moving the pseudo-roots directly.
    const crafted: EncodedOp<Meta>[] = [
      [100, 2, ROOT, "a", { name: "evil" }],
      [101, 2, TRASH, "a", { name: "evil" }],
    ];
    docs[1]!.getArray<EncodedOp<Meta>>("movable-tree").push(crafted);
    syncBothWays(docs[0]!, docs[1]!);

    for (const tree of trees) {
      expect(tree.toJSON()).toEqual(before);
      expect(tree.root.isDeleted).toBe(false);
      expect(tree.getNode("a")!.parent!.id).toBe(ROOT);
    }
  });

  it("a move deep into the node's own subtree is ignored", () => {
    const { docs, trees } = makeTrees(2);
    const treeA = trees[0]!;
    const a = treeA.root.createChild({ name: "a" }, "a");
    const b = a.createChild({ name: "b" }, "b");
    const c = b.createChild({ name: "c" }, "c");
    syncBothWays(docs[0]!, docs[1]!);
    const before = treeA.toJSON();

    a.moveTo(c); // would create a -> b -> c -> a
    expect(treeA.toJSON()).toEqual(before);

    syncBothWays(docs[0]!, docs[1]!);
    expect(trees[1]!.toJSON()).toEqual(before);
  });
});

describe("MovableTree delete and restore", () => {
  it("moves the subtree to trash and back", () => {
    const { trees } = makeTrees(1);
    const tree = trees[0]!;
    const folder = tree.root.createChild({ name: "folder" }, "folder");
    const file = folder.createChild({ name: "file" }, "file");
    const keep = tree.root.createChild({ name: "keep" }, "keep");

    folder.delete();
    expect(folder.parent).toBe(tree.trash);
    expect(folder.isDeleted).toBe(true);
    expect(file.isDeleted).toBe(true); // via ancestor
    expect(file.parent).toBe(folder); // subtree stays intact
    expect(keep.isDeleted).toBe(false);

    folder.restore();
    expect(folder.parent).toBe(tree.root);
    expect(file.isDeleted).toBe(false);

    folder.delete();
    folder.restore(keep);
    expect(folder.parent).toBe(keep);
  });
});

describe("MovableTree meta updates", () => {
  it("concurrent setMeta resolves last-writer-wins by timestamp on all replicas", () => {
    const { docs, trees } = makeTrees(2);
    const treeA = trees[0]!;
    const treeB = trees[1]!;
    treeA.root.createChild({ name: "original" }, "n");
    syncBothWays(docs[0]!, docs[1]!);

    // Both ops get counter 2; replica 2 wins the tie-break.
    treeA.getNode("n")!.setMeta({ name: "from-A" });
    treeB.getNode("n")!.setMeta({ name: "from-B" });
    syncBothWays(docs[0]!, docs[1]!);

    expect(treeA.toJSON()).toEqual(treeB.toJSON());
    expect(treeA.getNode("n")!.meta).toEqual({ name: "from-B" });
    expect(treeA.getNode("n")!.parent!.id).toBe(ROOT); // parent unchanged
  });
});

describe("MovableTree out-of-order and duplicate delivery", () => {
  it("integrating ops in reverse timestamp order matches in-order application", () => {
    const { docs, trees } = makeTrees(1);
    const reference = trees[0]!;
    const a = reference.root.createChild({ name: "a" }, "a");
    const b = reference.root.createChild({ name: "b" }, "b");
    a.moveTo(b);
    b.setMeta({ name: "b2" });
    const ops = docs[0]!.getArray<EncodedOp<Meta>>("movable-tree").toArray();
    expect(ops.length).toBe(4);

    // Deliver the ops to a fresh replica newest-first, one transaction each,
    // exercising the undo/insert/redo path on every step.
    const doc = new Y.Doc();
    const tree = new MovableTree<Meta>(doc, { replicaId: 9 });
    for (const op of [...ops].reverse()) {
      doc.getArray<EncodedOp<Meta>>("movable-tree").push([op]);
    }
    expect(tree.toJSON()).toEqual(reference.toJSON());
    expect(tree.getNode("a")!.parent!.id).toBe("b");
    expect(tree.getNode("b")!.meta).toEqual({ name: "b2" });

    // Scrambled order converges too.
    const doc2 = new Y.Doc();
    const tree2 = new MovableTree<Meta>(doc2, { replicaId: 10 });
    for (const index of [2, 0, 3, 1]) {
      doc2.getArray<EncodedOp<Meta>>("movable-tree").push([ops[index]!]);
    }
    expect(tree2.toJSON()).toEqual(reference.toJSON());
  });

  it("is idempotent under duplicate updates and re-construction", () => {
    const { docs, trees } = makeTrees(2);
    const treeA = trees[0]!;
    const treeB = trees[1]!;
    const a = treeA.root.createChild({ name: "a" }, "a");
    a.createChild({ name: "b" }, "b");

    const update = Y.encodeStateAsUpdate(docs[0]!);
    Y.applyUpdate(docs[1]!, update);
    const snapshot = treeB.toJSON();
    Y.applyUpdate(docs[1]!, update);
    Y.applyUpdate(docs[1]!, update);
    expect(treeB.toJSON()).toEqual(snapshot);
    expect(treeB.opCount).toBe(2);

    // A second instance over the already-populated doc replays to the same state.
    const again = new MovableTree<Meta>(docs[1]!, { replicaId: 5 });
    expect(again.toJSON()).toEqual(snapshot);
    expect(again.opCount).toBe(2);
  });
});

describe("MovableTree convergence", () => {
  it("converges across delivery permutations with duplicates", () => {
    const base = new Y.Doc();
    base.clientID = 9;
    const baseTree = new MovableTree<Meta>(base, { replicaId: 9 });
    const root = baseTree.root;
    root.createChild({ name: "n1" }, "n1");
    root.createChild({ name: "n2" }, "n2");
    root.createChild({ name: "n3" }, "n3");
    root.createChild({ name: "n4" }, "n4");
    const baseUpdate = Y.encodeStateAsUpdate(base);

    // Three replicas diverge from the common base with conflicting edits.
    const { docs, trees } = makeTrees(3);
    for (const doc of docs) Y.applyUpdate(doc, baseUpdate);
    trees[0]!.getNode("n1")!.moveTo(trees[0]!.getNode("n2")!);
    trees[0]!.getNode("n3")!.delete();
    trees[1]!.getNode("n2")!.moveTo(trees[1]!.getNode("n1")!); // conflicts with replica 1
    trees[1]!.getNode("n1")!.setMeta({ name: "renamed" });
    trees[2]!.getNode("n3")!.createChild({ name: "n5" }, "n5"); // child of a deleted node
    trees[2]!.getNode("n4")!.moveTo(trees[2]!.getNode("n5")!);
    const updates = docs.map((doc) => Y.encodeStateAsUpdate(doc));

    const permutations = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    const snapshots = permutations.map((permutation, index) => {
      const doc = new Y.Doc();
      doc.clientID = 100 + index;
      // Alternate constructing before (observer path) and after (replay path).
      const before =
        index % 2 === 0 ? new MovableTree<Meta>(doc, { replicaId: 100 + index }) : undefined;
      for (const updateIndex of permutation) {
        Y.applyUpdate(doc, updates[updateIndex]!);
      }
      Y.applyUpdate(doc, updates[permutation[0]!]!); // duplicate delivery
      const tree = before ?? new MovableTree<Meta>(doc, { replicaId: 100 + index });
      expectTreeInvariants(tree);
      return tree.toJSON();
    });

    for (const snapshot of snapshots.slice(1)) {
      expect(snapshot).toEqual(snapshots[0]!);
    }
  });

  it("fuzz: random concurrent ops with random partial syncs preserve all invariants", () => {
    for (const seed of [1, 42, 1337]) {
      const gen = prng.create(seed);
      const { docs, trees } = makeTrees(3);
      const createdIds: string[] = [];
      let nextId = 0;

      const randomNode = (tree: MovableTree<Meta>): TreeNode<Meta> | undefined => {
        const known = [...tree.nodes()];
        if (known.length === 0) return undefined;
        return known[prng.uint32(gen, 0, known.length - 1)];
      };

      for (let step = 0; step < 400; step++) {
        const tree = trees[prng.uint32(gen, 0, trees.length - 1)]!;
        const roll = prng.uint32(gen, 0, 99);
        const node = randomNode(tree);
        if (roll < 30 || node === undefined) {
          const parents = [tree.root, tree.trash, ...tree.nodes()];
          const parent = parents[prng.uint32(gen, 0, parents.length - 1)]!;
          const id = `n${nextId++}`;
          parent.createChild({ name: id }, id);
          createdIds.push(id);
        } else if (roll < 65) {
          // Random move — including attempts into the node's own subtree,
          // which must be recorded but ignored.
          const targets = [tree.root, tree.trash, ...tree.nodes()];
          const target = targets[prng.uint32(gen, 0, targets.length - 1)]!;
          if (target.id !== node.id) node.moveTo(target);
        } else if (roll < 80) {
          node.setMeta({ name: `${node.id}@${step}` });
        } else if (roll < 90) {
          node.delete();
        } else {
          node.restore();
        }
        if (step % 7 === 0) {
          // Random pairwise partial sync via state-vector diff.
          const from = prng.uint32(gen, 0, docs.length - 1);
          const to = prng.uint32(gen, 0, docs.length - 1);
          if (from !== to) {
            Y.applyUpdate(
              docs[to]!,
              Y.encodeStateAsUpdate(docs[from]!, Y.encodeStateVector(docs[to]!)),
            );
          }
        }
      }

      // Final full sync: two rounds of pairwise exchange reach everyone.
      for (let round = 0; round < 2; round++) {
        for (let i = 0; i < docs.length; i++) {
          for (let j = i + 1; j < docs.length; j++) {
            syncBothWays(docs[i]!, docs[j]!);
          }
        }
      }

      const reference = trees[0]!;
      for (const tree of trees) {
        // Convergence: identical snapshots and log sizes.
        expect(tree.toJSON()).toEqual(reference.toJSON());
        expect(tree.opCount).toBe(reference.opCount);
        // Acyclicity, reachability, children-index consistency.
        expectTreeInvariants(tree);
        // No duplication or loss: every created node exists exactly once.
        for (const id of createdIds) {
          expect(tree.has(id)).toBe(true);
        }
        expect([...tree.nodes()].length).toBe(createdIds.length);
      }
    }
  });
});
