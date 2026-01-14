# Connections

Teleportal supports multiple connection types for different environments and use cases.

## Connection Types

### FallbackConnection (Default)

Automatically tries WebSocket first, then falls back to HTTP if WebSocket fails.

```typescript
import { Provider } from "teleportal/providers";

// Automatically uses FallbackConnection
const provider = await Provider.create({
  url: "ws://localhost:3000",
  document: "my-document",
});
```

### WebSocketConnection

WebSocket-based connection with automatic reconnection.

```typescript
import { WebSocketConnection } from "teleportal/providers/websocket";

const connection = new WebSocketConnection({
  url: "ws://localhost:3000",
  maxReconnectAttempts: 10,
  initialReconnectDelay: 100,
  maxBackoffTime: 30000,
});

const provider = new Provider({
  client: connection,
  document: "my-document",
});
```

### HttpConnection

HTTP/SSE-based connection for environments where WebSockets aren't available.

```typescript
import { HttpConnection } from "teleportal/providers/http";

const connection = new HttpConnection({
  url: "http://localhost:3000",
  headers: {
    Authorization: "Bearer token",
  },
});

const provider = new Provider({
  client: connection,
  document: "my-document",
});
```

## Connection Options

### WebSocketConnection Options

```typescript
interface WebSocketConnectionOptions {
  url: string;                    // WebSocket URL
  protocols?: string[];          // WebSocket protocols
  connect?: boolean;             // Auto-connect (default: true)
  maxReconnectAttempts?: number;  // Max reconnection attempts (default: 10)
  initialReconnectDelay?: number; // Initial backoff delay in ms (default: 100)
  maxBackoffTime?: number;       // Max backoff time in ms (default: 30000)
  eventTarget?: EventTarget;     // For online/offline events
  isOnline?: boolean;            // Initial online state (default: true)
  heartbeatInterval?: number;    // Heartbeat interval in ms (default: 0 = disabled)
  messageReconnectTimeout?: number; // Timeout if no messages received (default: 30000)
}
```

### HttpConnection Options

```typescript
interface HttpConnectionOptions {
  url: string;                   // HTTP URL
  headers?: Record<string, string>; // HTTP headers
  connect?: boolean;            // Auto-connect (default: true)
  maxReconnectAttempts?: number; // Max reconnection attempts (default: 10)
  initialReconnectDelay?: number; // Initial backoff delay in ms (default: 100)
  maxBackoffTime?: number;      // Max backoff time in ms (default: 30000)
}
```

## Connection State

Monitor connection state:

```typescript
const connection = provider.state;

if (connection.type === "connected") {
  console.log("Connected!");
} else if (connection.type === "disconnected") {
  console.log("Disconnected");
} else if (connection.type === "connecting") {
  console.log("Connecting...");
} else if (connection.type === "errored") {
  console.error("Error:", connection.error);
}
```

## Reconnection

Connections automatically reconnect with exponential backoff:

```typescript
const connection = new WebSocketConnection({
  url: "ws://localhost:3000",
  maxReconnectAttempts: 10,      // Try up to 10 times
  initialReconnectDelay: 100,    // Start with 100ms delay
  maxBackoffTime: 30000,         // Cap at 30 seconds
});
```

### Reconnection Behavior

- **Exponential Backoff**: Delay increases exponentially: 100ms, 200ms, 400ms, 800ms, etc.
- **Max Attempts**: Stops after `maxReconnectAttempts`
- **Online/Offline Detection**: Pauses when offline, resumes when online
- **Manual Disconnect**: Doesn't reconnect if manually disconnected

## Message Buffering

Messages are automatically buffered when disconnected:

```typescript
// Messages sent while disconnected are buffered
connection.send(message1);
connection.send(message2);

// When reconnected, buffered messages are sent automatically
await connection.connected;
```

## Connection Sharing

Multiple providers can share the same connection:

```typescript
const connection = new WebSocketConnection({
  url: "ws://localhost:3000",
});

const provider1 = new Provider({
  client: connection,
  document: "doc1",
});

const provider2 = new Provider({
  client: connection,
  document: "doc2",
});
```

## Connection Lifecycle

```typescript
// Create connection
const connection = new WebSocketConnection({
  url: "ws://localhost:3000",
  connect: false, // Don't auto-connect
});

// Manually connect
await connection.connect();

// Use connection
const provider = new Provider({
  client: connection,
  document: "my-document",
});

// Disconnect (prevents reconnection)
await connection.disconnect();

// Destroy (permanent cleanup)
await connection.destroy();
```

## Error Handling

```typescript
connection.on("update", (state) => {
  if (state.type === "errored") {
    console.error("Connection error:", state.error);
    // Handle error
  }
});

try {
  await connection.connected;
} catch (error) {
  console.error("Connection failed:", error);
}
```

## Next Steps

- [Provider Setup](./provider-setup.md) - Learn more about providers
- [Offline Persistence](./offline-persistence.md) - Configure offline support
