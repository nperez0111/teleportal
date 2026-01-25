---
name: Webhooks for Document Events
overview: Implement a webhook system for document events (created, updated, idle, archived, rate-limit exceeded) as a separate sub-package that listens to server events and delivers webhooks with retry logic, timeouts, and authentication support.
todos:
  - id: create-types
    content: Create types.ts with WebhookConfig, WebhookEvent, WebhookPayload, and related types
    status: pending
  - id: create-document-tracker
    content: Implement document-tracker.ts to track document state, first-time creation, and idle timers
    status: pending
  - id: create-rate-limit-tracker
    content: Implement rate-limit-tracker.ts to track rate limit events at document and client levels
    status: pending
  - id: create-webhook-delivery
    content: Implement webhook-delivery.ts with HTTP delivery, retry logic, timeout, and auth support
    status: pending
  - id: create-webhook-manager
    content: Implement webhook-manager.ts to orchestrate event listening, tracking, and delivery
    status: pending
  - id: create-index-exports
    content: Create index.ts to export public API
    status: pending
  - id: create-readme
    content: Create README.md with usage examples and documentation
    status: pending
  - id: add-tests
    content: Add unit tests for webhook-manager, document-tracker, rate-limit-tracker, and webhook-delivery
    status: pending
---

# Webhooks for Document Events Implementation Plan

## Overview

Create a new `src/webhooks/` sub-package that listens to server events and delivers webhooks for document lifecycle events. The package will track document state, manage idle timeouts, integrate with rate limiters, and handle webhook delivery with retry logic.

## Architecture

The webhook system will:

- Listen to `ServerEvents` and `SessionEvents` from the server
- Track document state (created, last activity, idle timers)
- Track rate limits at both document and client levels
- Deliver webhooks with configurable retry, timeout, and authentication
- Support global webhook configuration

## File Structure

```
src/webhooks/
├── index.ts                    # Main exports
├── webhook-manager.ts          # Core webhook management and event handling
├── webhook-delivery.ts         # HTTP delivery with retry logic
├── document-tracker.ts         # Track document state and idle timers
├── rate-limit-tracker.ts      # Track rate limits at document/client levels
├── types.ts                    # TypeScript types and interfaces
├── README.md                   # Documentation
└── webhook-manager.test.ts     # Tests
```

## Implementation Details

### 1. Types (`src/webhooks/types.ts`)

Define webhook configuration and payload types:

- `WebhookConfig`: URL, headers, timeout, retry config, idle timeout
- `WebhookEvent`: Event type enum (created, updated, idle, archived, rate-limit-exceeded)
- `WebhookPayload`: Standard payload format with event type, document ID, timestamp, context
- `RateLimitScope`: "document" | "client" | "both"

### 2. Document Tracker (`src/webhooks/document-tracker.ts`)

Track document state for event detection:

- Track first-time document loads (for "created" event)
- Track last activity timestamp per document
- Manage idle timers per document (configurable timeout)
- Map `document-delete` to "archived" event
- Track document metadata (sessionId, encrypted, context)

### 3. Rate Limit Tracker (`src/webhooks/rate-limit-tracker.ts`)

Track rate limit events at document and client levels:

- Integrate with rate limiter callbacks from `src/transports/rate-limiter/index.ts`
- Track rate limit events per document (aggregate all clients)
- Track rate limit events per client
- Emit webhook events when rate limits are exceeded

### 4. Webhook Delivery (`src/webhooks/webhook-delivery.ts`)

Handle HTTP webhook delivery:

- `deliverWebhook()`: Send HTTP POST request with payload
- Retry logic with exponential backoff (configurable max retries)
- Configurable timeout per webhook
- Support custom headers (for authentication/API keys)
- Track delivery status (in-memory only)
- Handle errors gracefully (log, don't throw)

### 5. Webhook Manager (`src/webhooks/webhook-manager.ts`)

Main orchestrator that:

- Listens to server events:
  - `document-load` → emit "created" (if first time) and track document
  - `document-message` (from sessions) → emit "updated" and update last activity
  - `document-delete` → emit "archived"
  - Rate limiter callbacks → emit "rate-limit-exceeded"
- Manages idle timers (emit "idle" after configurable timeout)
- Coordinates document tracker, rate limit tracker, and delivery
- Provides `attachToServer()` method to hook into server instance

### 6. Integration Points

**Server Integration:**

- Hook into `Server<Context>` events via `server.on()` listeners
- Hook into `Session<Context>` events by subscribing to session events
- For rate limits: wrap transports with rate limiter and capture callbacks

**Event Mapping:**

- `document-load` → "created" (first time only, check if document was previously tracked)
- `document-message` (from sessions) → "updated" (update last activity)
- Idle timeout → "idle" (after no activity for configured duration)
- `document-delete` → "archived"
- Rate limiter `onRateLimitExceeded` → "rate-limit-exceeded"

## Key Implementation Notes

1. **Document Creation Detection**: Track documents in a Set/Map. On `document-load`, check if document was previously seen. If not, emit "created" event.

2. **Idle Detection**: Maintain a Map of document → last activity timestamp. Use `setTimeout` to check for idle documents periodically. Reset timer on any document activity.

3. **Rate Limit Integration**: The rate limiter is at transport level. We'll need to:

   - Provide a way to wrap transports with rate limiter that captures callbacks
   - Or provide a helper that users can use when creating rate-limited transports
   - Track rate limit events and map to document/client IDs

4. **Webhook Payload Format**: Standard format includes:
   ```typescript
   {
     event: "created" | "updated" | "idle" | "archived" | "rate-limit-exceeded",
     documentId: string,
     namespacedDocumentId: string,
     timestamp: number,
     sessionId?: string,
     clientId?: string,
     context?: Context,
     // Additional fields based on event type
   }
   ```

5. **Error Handling**: Webhook delivery failures should be logged but not throw errors. Retry logic handles transient failures.

## Usage Example

```typescript
import { WebhookManager } from "teleportal/webhooks";
import { Server } from "teleportal/server";

const server = new Server({ ... });

const webhookManager = new WebhookManager({
  webhooks: [
    {
      url: "https://api.example.com/webhooks",
      headers: { "Authorization": "Bearer token" },
      timeout: 5000,
      retry: { maxRetries: 3, backoffMs: 1000 },
      idleTimeout: 15 * 60 * 1000, // 15 minutes
      events: ["created", "updated", "idle", "archived", "rate-limit-exceeded"],
      rateLimitScope: "both"
    }
  ]
});

webhookManager.attachToServer(server);
```

## Testing Strategy

- Unit tests for document tracker (creation detection, idle timers)
- Unit tests for rate limit tracker
- Unit tests for webhook delivery (retry logic, timeout handling)
- Integration tests with mock server events
- Mock HTTP server for webhook delivery testing