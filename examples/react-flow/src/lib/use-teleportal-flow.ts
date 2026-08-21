import { useCallback, useEffect, useRef, useState } from "react";
import type { Connection, Edge, Node, NodeChange, EdgeChange } from "@xyflow/react";
import * as Y from "yjs";
import { throttle } from "teleportal/cursors";

import type { UseTeleportalFlowOptions, UseTeleportalFlowReturn } from "./types";
import { edgeToYMap, findConnectedEdges, nodeToYMap, yMapToEdge, yMapToNode } from "./sync";

interface LocalNodeState {
  selected?: boolean;
  dragging?: boolean;
  measured?: { width: number; height: number };
}

export function useTeleportalFlow(options: UseTeleportalFlowOptions): UseTeleportalFlowReturn {
  const { provider, initial } = options;
  const doc = provider.doc;

  const yNodes = doc.getMap("nodes") as Y.Map<Y.Map<unknown>>;
  const yEdges = doc.getMap("edges") as Y.Map<Y.Map<unknown>>;

  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const localNodeState = useRef<Map<string, LocalNodeState>>(new Map());
  const localEdgeSelected = useRef<Set<string>>(new Set());
  const initializedRef = useRef(false);

  const throttledPositionWrite = useRef(
    throttle((update: { id: string; position: { x: number; y: number } }) => {
      const yNode = yNodes.get(update.id);
      if (yNode) {
        yNode.set("position", update.position);
      }
    }, 50),
  ).current;

  const buildState = useCallback(() => {
    const builtNodes: Node[] = [];
    for (const [id, yNode] of yNodes) {
      const node = yMapToNode(id, yNode);
      const local = localNodeState.current.get(id);
      if (local?.selected) node.selected = true;
      if (local?.dragging) node.dragging = true;
      if (local?.measured) {
        (node as any).measured = local.measured;
      }
      builtNodes.push(node);
    }

    const builtEdges: Edge[] = [];
    for (const [id, yEdge] of yEdges) {
      const edge = yMapToEdge(id, yEdge);
      if (localEdgeSelected.current.has(id)) edge.selected = true;
      builtEdges.push(edge);
    }

    setNodes(builtNodes);
    setEdges(builtEdges);
  }, [yNodes, yEdges]);

  useEffect(() => {
    const sync = () => buildState();

    yNodes.observeDeep(sync);
    yEdges.observeDeep(sync);

    sync();

    return () => {
      yNodes.unobserveDeep(sync);
      yEdges.unobserveDeep(sync);
    };
  }, [yNodes, yEdges, buildState]);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    provider.synced.then(() => {
      if (yNodes.size === 0 && initial?.nodes?.length) {
        doc.transact(() => {
          for (const node of initial.nodes!) {
            yNodes.set(node.id, nodeToYMap(node, doc));
          }
        });
      }
      if (yEdges.size === 0 && initial?.edges?.length) {
        doc.transact(() => {
          for (const edge of initial.edges!) {
            yEdges.set(edge.id, edgeToYMap(edge, doc));
          }
        });
      }
      setIsLoading(false);
    });
  }, [provider, doc, yNodes, yEdges, initial]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      let needsRebuild = false;

      for (const change of changes) {
        switch (change.type) {
          case "position": {
            if (!change.position) break;
            const local = localNodeState.current.get(change.id) ?? {};

            if (change.dragging) {
              localNodeState.current.set(change.id, { ...local, dragging: true });
              throttledPositionWrite({ id: change.id, position: change.position });
            } else {
              localNodeState.current.set(change.id, { ...local, dragging: false });
              // Final position — write immediately, not throttled
              const yNode = yNodes.get(change.id);
              if (yNode) {
                yNode.set("position", change.position);
              }
            }
            break;
          }

          case "select": {
            const local = localNodeState.current.get(change.id) ?? {};
            localNodeState.current.set(change.id, { ...local, selected: change.selected });
            needsRebuild = true;
            break;
          }

          case "remove": {
            const nodeIds = new Set([change.id]);
            const connectedEdgeIds = findConnectedEdges(nodeIds, yEdges);
            doc.transact(() => {
              yNodes.delete(change.id);
              for (const edgeId of connectedEdgeIds) {
                yEdges.delete(edgeId);
              }
            });
            localNodeState.current.delete(change.id);
            break;
          }

          case "dimensions": {
            if (change.dimensions) {
              const local = localNodeState.current.get(change.id) ?? {};
              localNodeState.current.set(change.id, {
                ...local,
                measured: change.dimensions,
              });
              needsRebuild = true;

              if (change.resizing === false) {
                doc.transact(() => {
                  const yNode = yNodes.get(change.id);
                  if (yNode && change.dimensions) {
                    yNode.set("width", change.dimensions.width);
                    yNode.set("height", change.dimensions.height);
                  }
                });
              }
            }
            break;
          }

          case "add": {
            const node = (change as any).item as Node;
            if (node) {
              doc.transact(() => {
                yNodes.set(node.id, nodeToYMap(node, doc));
              });
            }
            break;
          }

          case "replace": {
            const node = (change as any).item as Node;
            if (node) {
              doc.transact(() => {
                yNodes.set(node.id, nodeToYMap(node, doc));
              });
            }
            break;
          }
        }
      }

      if (needsRebuild) {
        buildState();
      }
    },
    [doc, yNodes, yEdges, buildState, throttledPositionWrite],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      let needsRebuild = false;

      for (const change of changes) {
        switch (change.type) {
          case "select": {
            if (change.selected) {
              localEdgeSelected.current.add(change.id);
            } else {
              localEdgeSelected.current.delete(change.id);
            }
            needsRebuild = true;
            break;
          }

          case "remove": {
            yEdges.delete(change.id);
            localEdgeSelected.current.delete(change.id);
            break;
          }

          case "add": {
            const edge = (change as any).item as Edge;
            if (edge) {
              doc.transact(() => {
                yEdges.set(edge.id, edgeToYMap(edge, doc));
              });
            }
            break;
          }

          case "replace": {
            const edge = (change as any).item as Edge;
            if (edge) {
              doc.transact(() => {
                yEdges.set(edge.id, edgeToYMap(edge, doc));
              });
            }
            break;
          }
        }
      }

      if (needsRebuild) {
        buildState();
      }
    },
    [doc, yEdges, buildState],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      const id = `e-${connection.source}-${connection.sourceHandle ?? "default"}-${connection.target}-${connection.targetHandle ?? "default"}`;
      const edge: Edge = {
        id,
        source: connection.source,
        target: connection.target,
        sourceHandle: connection.sourceHandle,
        targetHandle: connection.targetHandle,
      };
      doc.transact(() => {
        yEdges.set(id, edgeToYMap(edge, doc));
      });
    },
    [doc, yEdges],
  );

  const onDelete = useCallback(
    ({ nodes: deletedNodes, edges: deletedEdges }: { nodes: Node[]; edges: Edge[] }) => {
      const nodeIds = new Set(deletedNodes.map((n) => n.id));
      const connectedEdgeIds = findConnectedEdges(nodeIds, yEdges);

      doc.transact(() => {
        for (const id of nodeIds) {
          yNodes.delete(id);
          localNodeState.current.delete(id);
        }
        for (const edgeId of connectedEdgeIds) {
          yEdges.delete(edgeId);
        }
        for (const edge of deletedEdges) {
          yEdges.delete(edge.id);
          localEdgeSelected.current.delete(edge.id);
        }
      });
    },
    [yNodes, yEdges],
  );

  return { nodes, edges, onNodesChange, onEdgesChange, onConnect, onDelete, isLoading };
}
