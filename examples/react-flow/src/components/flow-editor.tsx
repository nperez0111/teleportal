import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  ReactFlowProvider,
} from "@xyflow/react";
import type { Node, Edge } from "@xyflow/react";
import type { Provider } from "teleportal/providers";

import { useTeleportalFlow } from "../lib/use-teleportal-flow";
import { Cursors } from "../lib/cursors";

const defaultNodes: Node[] = [
  {
    id: "1",
    type: "input",
    data: { label: "Start" },
    position: { x: 250, y: 0 },
  },
  {
    id: "2",
    data: { label: "Process A" },
    position: { x: 100, y: 150 },
  },
  {
    id: "3",
    data: { label: "Process B" },
    position: { x: 400, y: 150 },
  },
  {
    id: "4",
    type: "output",
    data: { label: "End" },
    position: { x: 250, y: 300 },
  },
];

const defaultEdges: Edge[] = [
  { id: "e1-2", source: "1", target: "2" },
  { id: "e1-3", source: "1", target: "3" },
  { id: "e2-4", source: "2", target: "4" },
  { id: "e3-4", source: "3", target: "4" },
];

function FlowEditorInner({ provider }: { provider: Provider }) {
  const { nodes, edges, onNodesChange, onEdgesChange, onConnect, onDelete, isLoading } =
    useTeleportalFlow({
      provider,
      initial: { nodes: defaultNodes, edges: defaultEdges },
    });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen text-gray-500">
        Loading document...
      </div>
    );
  }

  return (
    <div style={{ width: "100vw", height: "100vh" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onDelete={onDelete}
        fitView
      >
        <Cursors provider={provider} />
        <Background />
        <Controls />
        <MiniMap />
      </ReactFlow>
    </div>
  );
}

export function FlowEditor({ provider }: { provider: Provider }) {
  return (
    <ReactFlowProvider>
      <FlowEditorInner provider={provider} />
    </ReactFlowProvider>
  );
}
