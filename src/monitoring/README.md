# Monitoring Module

The monitoring module provides metrics collection, health checks, and status reporting for the Teleportal server.

## Features

- **Prometheus Metrics**: Exports metrics in Prometheus text format.
- **Health Checks**: Provides a health status endpoint.
- **Status Reporting**: detailed operational status.
- **Document Size Tracking**: Tracks document sizes and alerts on growth.

## Metrics

The module collects the following metrics:

### Counters

- `teleportal_documents_opened_total`: Total number of documents opened
- `teleportal_messages_total`: Total number of messages processed (labeled by type)
- `teleportal_messages_total_all`: Total number of messages processed (aggregate)
- `teleportal_storage_operations_total`: Total storage operations
- `teleportal_errors_total`: Total errors encountered
- `teleportal_document_size_warning_total`: Total document size warnings triggered
- `teleportal_document_size_limit_exceeded_total`: Total document size limit exceeded events triggered
- `teleportal_milestones_created_total`: Total milestones created (labeled by triggerType)
- `teleportal_milestones_soft_deleted_total`: Total milestones soft deleted
- `teleportal_milestones_restored_total`: Total milestones restored

### Gauges

- `teleportal_clients_active`: Number of currently active client connections
- `teleportal_sessions_active`: Number of currently active document sessions
- `teleportal_document_size_bytes`: Current size of documents in bytes (labeled by documentId and encryption status)
- `teleportal_milestones_total`: Total number of milestones (labeled by lifecycleState)

### Histograms

- `teleportal_message_duration_seconds`: Duration of message processing
- `teleportal_storage_operation_duration_seconds`: Duration of storage operations

## Usage

### Metrics Collector

The `MetricsCollector` class aggregates metrics:

```typescript
import { MetricsCollector, register } from "teleportal/monitoring";

const collector = new MetricsCollector(register);

// Record metrics
collector.clientsActive.inc();
collector.recordDocumentSize("doc-1", 1024, false);
```

### HTTP Handlers

The module provides HTTP handlers for exposing monitoring endpoints:

```typescript
import {
  getMetricsHandler,
  getHealthHandler,
  getStatusHandler,
} from "teleportal/monitoring/http-handlers";

// Use with your HTTP server
app.get("/metrics", getMetricsHandler(server));
app.get("/health", getHealthHandler(server));
app.get("/status", getStatusHandler(server));
```

### Status Data

The status endpoint returns a `StatusData` object:

```typescript
interface StatusData {
  nodeId: string;
  activeClients: number;
  activeSessions: number;
  totalMessagesProcessed: number;
  totalDocumentsOpened: number;
  messageTypeBreakdown: Record<string, number>;
  uptime: number;
  timestamp: string;
  // Size stats
  totalDocumentSizeBytes?: number;
  documentsOverWarningThreshold?: number;
  documentsOverLimit?: number;
}
```
