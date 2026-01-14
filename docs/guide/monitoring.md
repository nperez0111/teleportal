# Monitoring

Teleportal provides built-in monitoring and metrics collection using Prometheus.

## Enabling Metrics

Enable metrics collection when creating the server:

```typescript
import { Server } from "teleportal/server";
import { createMetrics } from "teleportal/monitoring";

const server = new Server({
  getStorage: async (ctx) => {
    // ... storage setup
  },
  enableMetrics: true, // Enable metrics collection
});
```

## Metrics Endpoint

Expose metrics via HTTP endpoint:

```typescript
import { getMetricsHandlers } from "teleportal/monitoring";

const metricsHandlers = getMetricsHandlers(server);

// Express.js example
app.get("/metrics", metricsHandlers.metrics);
app.get("/health", metricsHandlers.health);
app.get("/status", metricsHandlers.status);
```

## Available Metrics

### Client Metrics

- `teleportal_clients_active` - Number of active clients
- `teleportal_sessions_active` - Number of active sessions

### Document Metrics

- `teleportal_documents_opened_total` - Total documents opened
- `teleportal_documents_created_total` - Total documents created

### Message Metrics

- `teleportal_messages_total` - Total messages processed (by type)
- `teleportal_messages_duration_seconds` - Message processing duration

### Storage Metrics

- `teleportal_storage_operations_total` - Storage operations (by type)
- `teleportal_storage_duration_seconds` - Storage operation duration

### Error Metrics

- `teleportal_errors_total` - Total errors (by type)

## Health Checks

```typescript
import { getHealthHandlers } from "teleportal/monitoring";

const healthHandlers = getHealthHandlers(server);

app.get("/health", healthHandlers.health);
```

Returns:
- `status`: "healthy" | "unhealthy"
- `components`: Component health status
- `uptime`: Server uptime in seconds

## Status Endpoint

```typescript
app.get("/status", healthHandlers.status);
```

Returns:
- `clients`: Number of active clients
- `sessions`: Number of active sessions
- `messages`: Message statistics
- `uptime`: Server uptime

## Next Steps

- [Server Setup](./server-setup.md) - Learn more about server configuration
