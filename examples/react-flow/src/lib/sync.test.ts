import { describe, expect, it } from "bun:test";
import type { Edge, Node } from "@xyflow/react";
import * as Y from "yjs";

import { edgeToYMap, findConnectedEdges, nodeToYMap, yMapToEdge, yMapToNode } from "./sync";

function syncDocs(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
}

function populateNode(doc: Y.Doc, node: Node) {
  const yNodes = doc.getMap("nodes") as Y.Map<Y.Map<unknown>>;
  doc.transact(() => {
    yNodes.set(node.id, nodeToYMap(node, doc));
  });
}

function populateEdge(doc: Y.Doc, edge: Edge) {
  const yEdges = doc.getMap("edges") as Y.Map<Y.Map<unknown>>;
  doc.transact(() => {
    yEdges.set(edge.id, edgeToYMap(edge, doc));
  });
}

function readNode(doc: Y.Doc, id: string): Node {
  const yNodes = doc.getMap("nodes") as Y.Map<Y.Map<unknown>>;
  return yMapToNode(id, yNodes.get(id)!);
}

function readEdge(doc: Y.Doc, id: string): Edge {
  const yEdges = doc.getMap("edges") as Y.Map<Y.Map<unknown>>;
  return yMapToEdge(id, yEdges.get(id)!);
}

describe("sync utilities", () => {
  describe("nodeToYMap / yMapToNode round-trip", () => {
    it("preserves all synced node fields", () => {
      const doc = new Y.Doc();
      const node: Node = {
        id: "n1",
        type: "custom",
        position: { x: 100, y: 200 },
        data: { label: "Hello", count: 42 },
        zIndex: 5,
        hidden: true,
        className: "my-node",
        style: { background: "red" },
        parentId: "group-1",
      };

      populateNode(doc, node);
      const result = readNode(doc, "n1");

      expect(result.id).toBe("n1");
      expect(result.type).toBe("custom");
      expect(result.position).toEqual({ x: 100, y: 200 });
      expect(result.data).toEqual({ label: "Hello", count: 42 });
      expect((result as any).zIndex).toBe(5);
      expect((result as any).hidden).toBe(true);
      expect((result as any).className).toBe("my-node");
      expect((result as any).style).toEqual({ background: "red" });
      expect((result as any).parentId).toBe("group-1");
    });

    it("skips local-only properties", () => {
      const doc = new Y.Doc();
      const node: Node = {
        id: "n1",
        position: { x: 0, y: 0 },
        data: { label: "test" },
        selected: true,
        dragging: true,
        measured: { width: 100, height: 50 },
        resizing: true,
      } as any;

      populateNode(doc, node);
      const yNodes = doc.getMap("nodes") as Y.Map<Y.Map<unknown>>;
      const ymap = yNodes.get("n1")!;

      expect(ymap.has("selected")).toBe(false);
      expect(ymap.has("dragging")).toBe(false);
      expect(ymap.has("measured")).toBe(false);
      expect(ymap.has("resizing")).toBe(false);
    });

    it("skips default values", () => {
      const doc = new Y.Doc();
      const node: Node = {
        id: "n1",
        position: { x: 0, y: 0 },
        data: {},
        hidden: false,
        expandParent: false,
      } as any;

      populateNode(doc, node);
      const yNodes = doc.getMap("nodes") as Y.Map<Y.Map<unknown>>;
      const ymap = yNodes.get("n1")!;

      expect(ymap.has("hidden")).toBe(false);
      expect(ymap.has("expandParent")).toBe(false);
      expect(ymap.has("position")).toBe(true);
    });

    it("writes non-default values for default-eligible fields", () => {
      const doc = new Y.Doc();
      const node: Node = {
        id: "n1",
        position: { x: 0, y: 0 },
        data: {},
        hidden: true,
        expandParent: true,
      } as any;

      populateNode(doc, node);
      const yNodes = doc.getMap("nodes") as Y.Map<Y.Map<unknown>>;
      const ymap = yNodes.get("n1")!;

      expect(ymap.get("hidden")).toBe(true);
      expect(ymap.get("expandParent")).toBe(true);
    });

    it("always provides data even when absent in Y.Map", () => {
      const doc = new Y.Doc();
      const yNodes = doc.getMap("nodes") as Y.Map<Y.Map<unknown>>;
      const ymap = new Y.Map<unknown>();
      ymap.set("position", { x: 0, y: 0 });
      yNodes.set("n1", ymap);

      const node = yMapToNode("n1", yNodes.get("n1")!);
      expect(node.data).toEqual({});
    });
  });

  describe("edgeToYMap / yMapToEdge round-trip", () => {
    it("preserves all synced edge fields", () => {
      const doc = new Y.Doc();
      const edge: Edge = {
        id: "e1",
        source: "n1",
        target: "n2",
        sourceHandle: "a",
        targetHandle: "b",
        type: "smoothstep",
        label: "connects",
        animated: true,
        data: { weight: 10 },
      };

      populateEdge(doc, edge);
      const result = readEdge(doc, "e1");

      expect(result.id).toBe("e1");
      expect(result.source).toBe("n1");
      expect(result.target).toBe("n2");
      expect(result.sourceHandle).toBe("a");
      expect(result.targetHandle).toBe("b");
      expect(result.type).toBe("smoothstep");
      expect(result.label).toBe("connects");
      expect(result.animated).toBe(true);
      expect(result.data).toEqual({ weight: 10 });
    });

    it("skips edge selected property", () => {
      const doc = new Y.Doc();
      const edge: Edge = {
        id: "e1",
        source: "n1",
        target: "n2",
        selected: true,
      };

      populateEdge(doc, edge);
      const yEdges = doc.getMap("edges") as Y.Map<Y.Map<unknown>>;
      const ymap = yEdges.get("e1")!;
      expect(ymap.has("selected")).toBe(false);
    });
  });

  describe("data as nested Y.Map", () => {
    it("stores data keys as individual Y.Map entries", () => {
      const doc = new Y.Doc();
      const node: Node = {
        id: "n1",
        position: { x: 0, y: 0 },
        data: { label: "test", count: 5, active: true },
      };

      populateNode(doc, node);
      const yNode = (doc.getMap("nodes") as Y.Map<Y.Map<unknown>>).get("n1")!;
      const yData = yNode.get("data") as Y.Map<unknown>;

      expect(yData).toBeInstanceOf(Y.Map);
      expect(yData.get("label")).toBe("test");
      expect(yData.get("count")).toBe(5);
      expect(yData.get("active")).toBe(true);
    });

    it("reads nested Y.Map data back as plain object", () => {
      const doc = new Y.Doc();
      const yNodes = doc.getMap("nodes") as Y.Map<Y.Map<unknown>>;
      const ymap = new Y.Map<unknown>();
      const yData = new Y.Map<unknown>();
      yData.set("label", "hello");
      yData.set("value", 42);
      ymap.set("data", yData);
      ymap.set("position", { x: 0, y: 0 });
      yNodes.set("n1", ymap);

      const node = yMapToNode("n1", yNodes.get("n1")!);
      expect(node.data).toEqual({ label: "hello", value: 42 });
    });
  });

  describe("findConnectedEdges", () => {
    it("finds edges connected to the given node IDs", () => {
      const doc = new Y.Doc();
      const yEdges = doc.getMap("edges") as Y.Map<Y.Map<unknown>>;

      populateEdge(doc, { id: "e1", source: "n1", target: "n2" });
      populateEdge(doc, { id: "e2", source: "n2", target: "n3" });
      populateEdge(doc, { id: "e3", source: "n3", target: "n4" });

      const connected = findConnectedEdges(new Set(["n2"]), yEdges);
      expect(connected.sort()).toEqual(["e1", "e2"]);
    });

    it("returns empty array when no edges match", () => {
      const doc = new Y.Doc();
      const yEdges = doc.getMap("edges") as Y.Map<Y.Map<unknown>>;

      populateEdge(doc, { id: "e1", source: "n1", target: "n2" });

      const connected = findConnectedEdges(new Set(["n99"]), yEdges);
      expect(connected).toEqual([]);
    });

    it("finds edges connected to multiple deleted nodes", () => {
      const doc = new Y.Doc();
      const yEdges = doc.getMap("edges") as Y.Map<Y.Map<unknown>>;

      populateEdge(doc, { id: "e1", source: "n1", target: "n2" });
      populateEdge(doc, { id: "e2", source: "n2", target: "n3" });
      populateEdge(doc, { id: "e3", source: "n4", target: "n5" });

      const connected = findConnectedEdges(new Set(["n1", "n3"]), yEdges);
      expect(connected.sort()).toEqual(["e1", "e2"]);
    });
  });
});

describe("concurrent editing", () => {
  describe("position changes", () => {
    it("two users moving different nodes converge", () => {
      const docA = new Y.Doc();
      const docB = new Y.Doc();

      populateNode(docA, {
        id: "n1",
        position: { x: 0, y: 0 },
        data: { label: "Node 1" },
      });
      populateNode(docA, {
        id: "n2",
        position: { x: 100, y: 100 },
        data: { label: "Node 2" },
      });

      syncDocs(docA, docB);

      // User A moves node 1, User B moves node 2 concurrently
      (docA.getMap("nodes").get("n1") as Y.Map<unknown>).set("position", { x: 50, y: 50 });
      (docB.getMap("nodes").get("n2") as Y.Map<unknown>).set("position", { x: 200, y: 200 });

      syncDocs(docA, docB);

      const nodeA1 = readNode(docA, "n1");
      const nodeA2 = readNode(docA, "n2");
      const nodeB1 = readNode(docB, "n1");
      const nodeB2 = readNode(docB, "n2");

      expect(nodeA1.position).toEqual({ x: 50, y: 50 });
      expect(nodeA2.position).toEqual({ x: 200, y: 200 });
      expect(nodeB1.position).toEqual(nodeA1.position);
      expect(nodeB2.position).toEqual(nodeA2.position);
    });

    it("two users moving the same node — one position wins (LWW)", () => {
      const docA = new Y.Doc();
      const docB = new Y.Doc();

      populateNode(docA, {
        id: "n1",
        position: { x: 0, y: 0 },
        data: {},
      });

      syncDocs(docA, docB);

      // Both move the same node concurrently
      (docA.getMap("nodes").get("n1") as Y.Map<unknown>).set("position", { x: 10, y: 10 });
      (docB.getMap("nodes").get("n1") as Y.Map<unknown>).set("position", { x: 99, y: 99 });

      syncDocs(docA, docB);

      // Both docs converge to the same position (LWW by clientID)
      const posA = readNode(docA, "n1").position;
      const posB = readNode(docB, "n1").position;
      expect(posA).toEqual(posB);
    });
  });

  describe("independent field edits", () => {
    it("position change and data change on the same node merge without conflict", () => {
      const docA = new Y.Doc();
      const docB = new Y.Doc();

      populateNode(docA, {
        id: "n1",
        position: { x: 0, y: 0 },
        data: { label: "original" },
      });

      syncDocs(docA, docB);

      // User A moves the node
      (docA.getMap("nodes").get("n1") as Y.Map<unknown>).set("position", { x: 300, y: 400 });

      // User B edits the data label
      const yDataB = (docB.getMap("nodes").get("n1") as Y.Map<unknown>).get("data") as Y.Map<unknown>;
      yDataB.set("label", "renamed");

      syncDocs(docA, docB);

      const nodeA = readNode(docA, "n1");
      const nodeB = readNode(docB, "n1");

      // Both edits survive
      expect(nodeA.position).toEqual({ x: 300, y: 400 });
      expect(nodeA.data).toEqual({ label: "renamed" });
      expect(nodeB.position).toEqual(nodeA.position);
      expect(nodeB.data).toEqual(nodeA.data);
    });

    it("type change and position change on the same node merge", () => {
      const docA = new Y.Doc();
      const docB = new Y.Doc();

      populateNode(docA, {
        id: "n1",
        type: "default",
        position: { x: 0, y: 0 },
        data: {},
      });

      syncDocs(docA, docB);

      (docA.getMap("nodes").get("n1") as Y.Map<unknown>).set("type", "custom");
      (docB.getMap("nodes").get("n1") as Y.Map<unknown>).set("position", { x: 50, y: 50 });

      syncDocs(docA, docB);

      const nodeA = readNode(docA, "n1");
      const nodeB = readNode(docB, "n1");

      expect(nodeA.type).toBe("custom");
      expect(nodeA.position).toEqual({ x: 50, y: 50 });
      expect(nodeB.type).toBe(nodeA.type);
      expect(nodeB.position).toEqual(nodeA.position);
    });
  });

  describe("data Y.Map granularity", () => {
    it("two users editing different data keys on the same node both survive", () => {
      const docA = new Y.Doc();
      const docB = new Y.Doc();

      populateNode(docA, {
        id: "n1",
        position: { x: 0, y: 0 },
        data: { label: "test", count: 0, color: "blue" },
      });

      syncDocs(docA, docB);

      // User A changes label, User B changes count
      const dataA = (docA.getMap("nodes").get("n1") as Y.Map<unknown>).get("data") as Y.Map<unknown>;
      const dataB = (docB.getMap("nodes").get("n1") as Y.Map<unknown>).get("data") as Y.Map<unknown>;

      dataA.set("label", "updated by A");
      dataB.set("count", 42);

      syncDocs(docA, docB);

      const nodeA = readNode(docA, "n1");
      const nodeB = readNode(docB, "n1");

      expect(nodeA.data).toEqual({ label: "updated by A", count: 42, color: "blue" });
      expect(nodeB.data).toEqual(nodeA.data);
    });

    it("two users editing the same data key — LWW by clientID, both converge", () => {
      const docA = new Y.Doc();
      const docB = new Y.Doc();

      populateNode(docA, {
        id: "n1",
        position: { x: 0, y: 0 },
        data: { label: "original" },
      });

      syncDocs(docA, docB);

      const dataA = (docA.getMap("nodes").get("n1") as Y.Map<unknown>).get("data") as Y.Map<unknown>;
      const dataB = (docB.getMap("nodes").get("n1") as Y.Map<unknown>).get("data") as Y.Map<unknown>;

      dataA.set("label", "from A");
      dataB.set("label", "from B");

      syncDocs(docA, docB);

      const nodeA = readNode(docA, "n1");
      const nodeB = readNode(docB, "n1");

      // Both converge to the same value (LWW)
      expect(nodeA.data.label).toBe(nodeB.data.label);
    });

    it("adding a new data key while another user edits an existing key", () => {
      const docA = new Y.Doc();
      const docB = new Y.Doc();

      populateNode(docA, {
        id: "n1",
        position: { x: 0, y: 0 },
        data: { label: "test" },
      });

      syncDocs(docA, docB);

      const dataA = (docA.getMap("nodes").get("n1") as Y.Map<unknown>).get("data") as Y.Map<unknown>;
      const dataB = (docB.getMap("nodes").get("n1") as Y.Map<unknown>).get("data") as Y.Map<unknown>;

      dataA.set("label", "updated");
      dataB.set("description", "newly added");

      syncDocs(docA, docB);

      const nodeA = readNode(docA, "n1");
      const nodeB = readNode(docB, "n1");

      expect(nodeA.data).toEqual({ label: "updated", description: "newly added" });
      expect(nodeB.data).toEqual(nodeA.data);
    });
  });

  describe("node add and remove", () => {
    it("two users adding different nodes concurrently", () => {
      const docA = new Y.Doc();
      const docB = new Y.Doc();

      syncDocs(docA, docB);

      populateNode(docA, { id: "n1", position: { x: 0, y: 0 }, data: { label: "A's node" } });
      populateNode(docB, { id: "n2", position: { x: 100, y: 100 }, data: { label: "B's node" } });

      syncDocs(docA, docB);

      const nodesA = docA.getMap("nodes") as Y.Map<Y.Map<unknown>>;
      const nodesB = docB.getMap("nodes") as Y.Map<Y.Map<unknown>>;

      expect(nodesA.size).toBe(2);
      expect(nodesB.size).toBe(2);
      expect(readNode(docA, "n1").data).toEqual({ label: "A's node" });
      expect(readNode(docA, "n2").data).toEqual({ label: "B's node" });
      expect(readNode(docB, "n1").data).toEqual({ label: "A's node" });
      expect(readNode(docB, "n2").data).toEqual({ label: "B's node" });
    });

    it("one user removes a node while another edits it — delete wins", () => {
      const docA = new Y.Doc();
      const docB = new Y.Doc();

      populateNode(docA, { id: "n1", position: { x: 0, y: 0 }, data: { label: "victim" } });

      syncDocs(docA, docB);

      // User A deletes the node
      (docA.getMap("nodes") as Y.Map<Y.Map<unknown>>).delete("n1");

      // User B edits it (not knowing it's being deleted)
      (docB.getMap("nodes").get("n1") as Y.Map<unknown>).set("position", { x: 999, y: 999 });

      syncDocs(docA, docB);

      // The node is gone on A (deleted). On B, the Y.Map entry was deleted from the
      // parent nodes map — Y.Map.delete removes the entry regardless of concurrent
      // sub-edits. Both docs converge.
      const nodesA = docA.getMap("nodes") as Y.Map<Y.Map<unknown>>;
      const nodesB = docB.getMap("nodes") as Y.Map<Y.Map<unknown>>;

      expect(nodesA.has("n1")).toBe(false);
      expect(nodesB.has("n1")).toBe(false);
    });

    it("node deletion removes connected edges in a transaction", () => {
      const doc = new Y.Doc();

      populateNode(doc, { id: "n1", position: { x: 0, y: 0 }, data: {} });
      populateNode(doc, { id: "n2", position: { x: 100, y: 0 }, data: {} });
      populateNode(doc, { id: "n3", position: { x: 200, y: 0 }, data: {} });
      populateEdge(doc, { id: "e1-2", source: "n1", target: "n2" });
      populateEdge(doc, { id: "e2-3", source: "n2", target: "n3" });
      populateEdge(doc, { id: "e1-3", source: "n1", target: "n3" });

      const yNodes = doc.getMap("nodes") as Y.Map<Y.Map<unknown>>;
      const yEdges = doc.getMap("edges") as Y.Map<Y.Map<unknown>>;

      const deletedNodeIds = new Set(["n2"]);
      const connectedEdgeIds = findConnectedEdges(deletedNodeIds, yEdges);

      doc.transact(() => {
        for (const id of deletedNodeIds) yNodes.delete(id);
        for (const id of connectedEdgeIds) yEdges.delete(id);
      });

      expect(yNodes.size).toBe(2);
      expect(yEdges.size).toBe(1);
      expect(yEdges.has("e1-3")).toBe(true);
      expect(yEdges.has("e1-2")).toBe(false);
      expect(yEdges.has("e2-3")).toBe(false);
    });
  });

  describe("edge operations", () => {
    it("two users adding different edges concurrently", () => {
      const docA = new Y.Doc();
      const docB = new Y.Doc();

      populateNode(docA, { id: "n1", position: { x: 0, y: 0 }, data: {} });
      populateNode(docA, { id: "n2", position: { x: 100, y: 0 }, data: {} });
      populateNode(docA, { id: "n3", position: { x: 200, y: 0 }, data: {} });

      syncDocs(docA, docB);

      populateEdge(docA, { id: "e1-2", source: "n1", target: "n2" });
      populateEdge(docB, { id: "e2-3", source: "n2", target: "n3" });

      syncDocs(docA, docB);

      const edgesA = docA.getMap("edges") as Y.Map<Y.Map<unknown>>;
      const edgesB = docB.getMap("edges") as Y.Map<Y.Map<unknown>>;

      expect(edgesA.size).toBe(2);
      expect(edgesB.size).toBe(2);
    });

    it("deterministic edge ID prevents duplicate connections", () => {
      const docA = new Y.Doc();
      const docB = new Y.Doc();

      populateNode(docA, { id: "n1", position: { x: 0, y: 0 }, data: {} });
      populateNode(docA, { id: "n2", position: { x: 100, y: 0 }, data: {} });

      syncDocs(docA, docB);

      // Both users connect the same ports — same deterministic ID
      const edgeId = "e-n1-default-n2-default";
      populateEdge(docA, { id: edgeId, source: "n1", target: "n2" });
      populateEdge(docB, { id: edgeId, source: "n1", target: "n2" });

      syncDocs(docA, docB);

      // Only one edge exists (same key in Y.Map = single entry)
      const edgesA = docA.getMap("edges") as Y.Map<Y.Map<unknown>>;
      const edgesB = docB.getMap("edges") as Y.Map<Y.Map<unknown>>;

      expect(edgesA.size).toBe(1);
      expect(edgesB.size).toBe(1);
    });
  });

  describe("transaction atomicity", () => {
    it("batched node + edge creation is observed as a single update", () => {
      const doc = new Y.Doc();
      const yNodes = doc.getMap("nodes") as Y.Map<Y.Map<unknown>>;
      const yEdges = doc.getMap("edges") as Y.Map<Y.Map<unknown>>;

      let updateCount = 0;
      doc.on("update", () => updateCount++);

      doc.transact(() => {
        yNodes.set("n1", nodeToYMap({ id: "n1", position: { x: 0, y: 0 }, data: {} }, doc));
        yNodes.set("n2", nodeToYMap({ id: "n2", position: { x: 100, y: 0 }, data: {} }, doc));
        yEdges.set("e1", edgeToYMap({ id: "e1", source: "n1", target: "n2" }, doc));
      });

      expect(updateCount).toBe(1);
      expect(yNodes.size).toBe(2);
      expect(yEdges.size).toBe(1);
    });

    it("observer sees consistent state within a transaction", () => {
      const doc = new Y.Doc();
      const yNodes = doc.getMap("nodes") as Y.Map<Y.Map<unknown>>;
      const yEdges = doc.getMap("edges") as Y.Map<Y.Map<unknown>>;

      let nodeCountAtObserve = -1;
      let edgeCountAtObserve = -1;

      doc.on("update", () => {
        nodeCountAtObserve = yNodes.size;
        edgeCountAtObserve = yEdges.size;
      });

      doc.transact(() => {
        yNodes.set("n1", nodeToYMap({ id: "n1", position: { x: 0, y: 0 }, data: {} }, doc));
        yNodes.set("n2", nodeToYMap({ id: "n2", position: { x: 100, y: 0 }, data: {} }, doc));
        yEdges.set("e1", edgeToYMap({ id: "e1", source: "n1", target: "n2" }, doc));
      });

      expect(nodeCountAtObserve).toBe(2);
      expect(edgeCountAtObserve).toBe(1);
    });
  });

  describe("three-way concurrent editing", () => {
    it("three users each editing different nodes converge to the same state", () => {
      const docA = new Y.Doc();
      const docB = new Y.Doc();
      const docC = new Y.Doc();

      populateNode(docA, { id: "n1", position: { x: 0, y: 0 }, data: { label: "1" } });
      populateNode(docA, { id: "n2", position: { x: 100, y: 0 }, data: { label: "2" } });
      populateNode(docA, { id: "n3", position: { x: 200, y: 0 }, data: { label: "3" } });

      syncDocs(docA, docB);
      syncDocs(docA, docC);

      // Each user edits a different node
      (docA.getMap("nodes").get("n1") as Y.Map<unknown>).set("position", { x: 10, y: 10 });
      const dataB = (docB.getMap("nodes").get("n2") as Y.Map<unknown>).get("data") as Y.Map<unknown>;
      dataB.set("label", "edited by B");
      (docC.getMap("nodes").get("n3") as Y.Map<unknown>).set("type", "output");

      // Sync all pairs
      syncDocs(docA, docB);
      syncDocs(docB, docC);
      syncDocs(docA, docC);

      const expectState = (doc: Y.Doc) => {
        expect(readNode(doc, "n1").position).toEqual({ x: 10, y: 10 });
        expect(readNode(doc, "n2").data).toEqual({ label: "edited by B" });
        expect(readNode(doc, "n3").type).toBe("output");
      };

      expectState(docA);
      expectState(docB);
      expectState(docC);
    });

    it("three users editing the same node's data — all different keys survive", () => {
      const docA = new Y.Doc();
      const docB = new Y.Doc();
      const docC = new Y.Doc();

      populateNode(docA, {
        id: "n1",
        position: { x: 0, y: 0 },
        data: { a: "original", b: "original", c: "original" },
      });

      syncDocs(docA, docB);
      syncDocs(docA, docC);

      const dataA = (docA.getMap("nodes").get("n1") as Y.Map<unknown>).get("data") as Y.Map<unknown>;
      const dataB = (docB.getMap("nodes").get("n1") as Y.Map<unknown>).get("data") as Y.Map<unknown>;
      const dataC = (docC.getMap("nodes").get("n1") as Y.Map<unknown>).get("data") as Y.Map<unknown>;

      dataA.set("a", "from A");
      dataB.set("b", "from B");
      dataC.set("c", "from C");

      syncDocs(docA, docB);
      syncDocs(docB, docC);
      syncDocs(docA, docC);

      const expected = { a: "from A", b: "from B", c: "from C" };
      expect(readNode(docA, "n1").data).toEqual(expected);
      expect(readNode(docB, "n1").data).toEqual(expected);
      expect(readNode(docC, "n1").data).toEqual(expected);
    });
  });

  describe("position stored as atomic value", () => {
    it("position is a single {x, y} object, not separate x/y keys", () => {
      const doc = new Y.Doc();
      populateNode(doc, { id: "n1", position: { x: 42, y: 99 }, data: {} });

      const yNode = (doc.getMap("nodes") as Y.Map<Y.Map<unknown>>).get("n1")!;
      const pos = yNode.get("position");

      expect(pos).toEqual({ x: 42, y: 99 });
      expect(yNode.has("x")).toBe(false);
      expect(yNode.has("y")).toBe(false);
    });

    it("position update replaces the entire {x, y} atomically", () => {
      const docA = new Y.Doc();
      const docB = new Y.Doc();

      populateNode(docA, { id: "n1", position: { x: 0, y: 0 }, data: {} });
      syncDocs(docA, docB);

      // Both docs see the node
      expect(readNode(docB, "n1").position).toEqual({ x: 0, y: 0 });

      // Update position on A
      (docA.getMap("nodes").get("n1") as Y.Map<unknown>).set("position", { x: 50, y: 75 });
      syncDocs(docA, docB);

      expect(readNode(docB, "n1").position).toEqual({ x: 50, y: 75 });
    });
  });

  describe("schema resilience", () => {
    it("a node with no type field reads back without type", () => {
      const doc = new Y.Doc();
      populateNode(doc, { id: "n1", position: { x: 0, y: 0 }, data: {} });

      const node = readNode(doc, "n1");
      expect(node.type).toBeUndefined();
    });

    it("extra unknown fields survive round-trip via Y.Map", () => {
      const doc = new Y.Doc();
      const yNodes = doc.getMap("nodes") as Y.Map<Y.Map<unknown>>;
      const ymap = new Y.Map<unknown>();
      ymap.set("position", { x: 0, y: 0 });
      ymap.set("customField", "hello");
      const yData = new Y.Map<unknown>();
      yData.set("label", "test");
      ymap.set("data", yData);
      yNodes.set("n1", ymap);

      const node = readNode(doc, "n1");
      expect((node as any).customField).toBe("hello");
    });
  });
});
