import type { ComponentType } from "react";
import type { Edge, Node, OnConnect, OnDelete, OnEdgesChange, OnNodesChange } from "@xyflow/react";
import type { Provider } from "teleportal/providers";

export interface UseTeleportalFlowOptions {
  provider: Provider;
  initial?: { nodes?: Node[]; edges?: Edge[] };
}

export interface UseTeleportalFlowReturn {
  nodes: Node[];
  edges: Edge[];
  onNodesChange: OnNodesChange;
  onEdgesChange: OnEdgesChange;
  onConnect: OnConnect;
  onDelete: OnDelete;
  isLoading: boolean;
}

export interface CursorsProps {
  provider: Provider;
  components?: { Cursor?: ComponentType<CursorComponentProps> };
}

export interface CursorComponentProps {
  x: number;
  y: number;
  name?: string;
  color?: string;
  clientId: number;
}
