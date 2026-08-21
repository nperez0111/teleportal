import type { Edge, Node } from "@xyflow/react";
import * as Y from "yjs";

const LOCAL_ONLY_NODE_PROPS = new Set(["selected", "dragging", "measured", "resizing"]);
const LOCAL_ONLY_EDGE_PROPS = new Set(["selected"]);

const NODE_DEFAULTS: Record<string, unknown> = {
  hidden: false,
  draggable: undefined,
  selectable: undefined,
  connectable: undefined,
  deletable: undefined,
  focusable: undefined,
  expandParent: false,
};

const EDGE_DEFAULTS: Record<string, unknown> = {
  hidden: false,
  animated: false,
  deletable: undefined,
  selectable: undefined,
  focusable: undefined,
};

function isDefault(key: string, value: unknown, defaults: Record<string, unknown>): boolean {
  return key in defaults && value === defaults[key];
}

export function nodeToYMap(node: Node, doc: Y.Doc): Y.Map<unknown> {
  const ymap = new Y.Map<unknown>();

  for (const [key, value] of Object.entries(node)) {
    if (key === "id") continue;
    if (LOCAL_ONLY_NODE_PROPS.has(key)) continue;
    if (value === undefined) continue;
    if (isDefault(key, value, NODE_DEFAULTS)) continue;

    if (key === "data") {
      const yData = new Y.Map<unknown>();
      if (value && typeof value === "object") {
        for (const [dk, dv] of Object.entries(value as Record<string, unknown>)) {
          yData.set(dk, dv);
        }
      }
      ymap.set("data", yData);
    } else {
      ymap.set(key, value);
    }
  }

  return ymap;
}

export function yMapToNode(id: string, ymap: Y.Map<unknown>): Node {
  const node: Record<string, unknown> = { id };

  for (const [key, value] of ymap.entries()) {
    if (key === "data") {
      if (value instanceof Y.Map) {
        node.data = Object.fromEntries(value.entries());
      } else {
        node.data = value ?? {};
      }
    } else {
      node[key] = value;
    }
  }

  if (!node.data) node.data = {};

  return node as Node;
}

export function edgeToYMap(edge: Edge, doc: Y.Doc): Y.Map<unknown> {
  const ymap = new Y.Map<unknown>();

  for (const [key, value] of Object.entries(edge)) {
    if (key === "id") continue;
    if (LOCAL_ONLY_EDGE_PROPS.has(key)) continue;
    if (value === undefined) continue;
    if (isDefault(key, value, EDGE_DEFAULTS)) continue;

    if (key === "data") {
      const yData = new Y.Map<unknown>();
      if (value && typeof value === "object") {
        for (const [dk, dv] of Object.entries(value as Record<string, unknown>)) {
          yData.set(dk, dv);
        }
      }
      ymap.set("data", yData);
    } else {
      ymap.set(key, value);
    }
  }

  return ymap;
}

export function yMapToEdge(id: string, ymap: Y.Map<unknown>): Edge {
  const edge: Record<string, unknown> = { id };

  for (const [key, value] of ymap.entries()) {
    if (key === "data") {
      if (value instanceof Y.Map) {
        edge.data = Object.fromEntries(value.entries());
      } else {
        edge.data = value ?? {};
      }
    } else {
      edge[key] = value;
    }
  }

  return edge as Edge;
}

export function findConnectedEdges(nodeIds: Set<string>, yEdges: Y.Map<Y.Map<unknown>>): string[] {
  const result: string[] = [];
  for (const [edgeId, yEdge] of yEdges) {
    const source = yEdge.get("source") as string;
    const target = yEdge.get("target") as string;
    if (nodeIds.has(source) || nodeIds.has(target)) {
      result.push(edgeId);
    }
  }
  return result;
}
