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
  totalDocumentSizeBytes?: number;
  documentsOverWarningThreshold?: number;
  documentsOverLimit?: number;
  rateLimitExceededTotal?: number;
  rateLimitBreakdown?: Record<string, number>;
  rateLimitTopOffenders?: Array<{
    userId: string;
    documentId: string;
    count: number;
    trackBy: string;
  }>;
  rateLimitRecentEvents?: Array<{
    timestamp: string;
    userId: string;
    documentId: string;
    trackBy: string;
  }>;
}

export interface MetricsData {
  prometheus: string; // Prometheus-formatted metrics string
}
