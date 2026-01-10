export interface HealthStatus {
  status: "healthy" | "unhealthy";
  timestamp: string;
  checks: Record<string, "healthy" | "unhealthy" | "unknown">;
  uptime?: number; // seconds
}

export interface StatusData {
  nodeId: string;
  activeClients: number;
  activeSessions: number;
  pendingSessions: number;
  totalMessagesProcessed: number;
  totalDocumentsOpened: number;
  messageTypeBreakdown: Record<string, number>;
  uptime: number; // seconds
  timestamp: string;
}

export interface MetricsData {
  prometheus: string; // Prometheus-formatted metrics string
}
