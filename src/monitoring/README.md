# Monitoring Module

The monitoring module provides metrics collection, health checks, and status reporting for the Teleportal server.

## Features

- **Prometheus Metrics**: Exports metrics in Prometheus text format.
- **Health Checks**: Provides a health status endpoint.
- **Status Reporting**: Detailed operational status.
- **Document Size Tracking**: Tracks document sizes and alerts on growth.
- **Rate Limit Tracking**: Exceeded events, flow-control delays, state operations, and top offenders.

## Metrics

The module collects the following metrics:

### Counters

- `teleportal_documents_opened_total`: Total number of documents opened
- `teleportal_messages_total`: Total number of messages processed (labeled by `type`)
- `teleportal_messages_total_all`: Total number of messages processed (aggregate)
- `teleportal_storage_operations_total`: Total storage operations (labeled by `operation`, `result`)
- `teleportal_errors_total`: Total errors encountered (labeled by `type`)
- `teleportal_document_size_warning_total`: Document size warnings (labeled by `documentId`)
- `teleportal_document_size_limit_exceeded_total`: Document size limit exceeded events (labeled by `documentId`)
- `teleportal_milestones_created_total`: Milestones created (labeled by `documentId`, `triggerType`)
- `teleportal_milestones_soft_deleted_total`: Milestones soft deleted (labeled by `documentId`)
- `teleportal_milestones_restored_total`: Milestones restored (labeled by `documentId`)
- `teleportal_rate_limit_exceeded_total`: Rate limit exceeded (dropped) events (labeled by `userId`, `documentId`, `trackBy`)
- `teleportal_rate_limit_delayed_total`: Inbound messages held by rate limiting flow control (labeled by `userId`, `documentId`, `trackBy`)
- `teleportal_rate_limit_delay_ms_total`: Cumulative milliseconds messages spent held by rate limiting (labeled by `userId`, `documentId`, `trackBy`)
- `teleportal_rate_limit_state_operations_total`: Rate limit state storage operations (labeled by `operation`, `trackBy`)

### Gauges

- `teleportal_clients_active`: Currently active client connections
- `teleportal_sessions_active`: Currently active document sessions
- `teleportal_document_size_bytes`: Current document size in bytes (labeled by `documentId`, `encrypted`)
- `teleportal_milestones_total`: Milestone count (labeled by `documentId`, `lifecycleState`)
- `teleportal_rate_limit_state_size`: Active rate limit states (labeled by `trackBy`)

### Histograms

- `teleportal_message_duration_seconds`: Duration of message processing (labeled by `type`)
- `teleportal_storage_operation_duration_seconds`: Duration of storage operations (labeled by `operation`)

## Usage

### Metrics Collector

The `MetricsCollector` class aggregates metrics:

```typescript
import { MetricsCollector } from "teleportal/monitoring";
import { Registry } from "teleportal/monitoring/metrics";

const registry = new Registry();
const collector = new MetricsCollector(registry);

// Record metrics
collector.clientsActive.inc();
collector.recordDocumentSize("doc-1", 1024, false);
collector.incrementMessage("doc");
collector.recordRateLimitExceeded("user-1", "doc-1", "user");
collector.recordRateLimitDelayed("user-1", "doc-1", "user", 50);

// Prometheus export
const prometheusText = registry.format();
```

### Status Data

The status endpoint returns a `StatusData` object:

```typescript
interface StatusData {
  nodeId: string;
  activeClients: number;
  activeSessions: number;
  pendingSessions: number;
  totalMessagesProcessed: number;
  totalDocumentsOpened: number;
  messageTypeBreakdown: Record<string, number>;
  uptime: number;
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
```

### Querying Rate Limit Data

```typescript
// Top offenders sorted by count
const offenders = collector.getRateLimitTopOffenders(10);

// Recent events (newest first, capped at 100)
const events = collector.getRateLimitRecentEvents(10);

// Breakdown by tracking dimension
const breakdown = collector.getRateLimitCountsByTrackBy();
```
