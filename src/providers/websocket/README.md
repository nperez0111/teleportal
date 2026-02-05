# Enhanced WebSocket Connection Manager

This WebSocket connection manager provides robust reconnection capabilities with exponential backoff, message buffering, and comprehensive error handling.

## Key Features

### 🔄 Robust Reconnection
- **Exponential Backoff**: Implements proper exponential backoff algorithm with configurable base delay and maximum backoff time
- **Configurable Retry Limits**: Set maximum reconnection attempts to prevent infinite retry loops
- **Smart Reconnection Logic**: Only attempts reconnection when connection was lost due to network issues, not user-initiated disconnects
- **Online/Offline Detection**: Automatically pauses reconnection attempts when device goes offline and resumes when back online

### 📨 Message Buffering
- **Automatic Buffering**: Messages sent while disconnected are automatically buffered
- **Configurable Buffer Size**: Set maximum number of messages to buffer (default: 100)
- **FIFO Queue**: Messages are sent in the order they were received when connection is restored
- **Buffer Management**: Direct access to buffer array for monitoring and management

### 🎯 Enhanced State Management
- **Comprehensive State Tracking**: Track connection state, reconnect attempts, and last connection time
- **User Intent Tracking**: Distinguish between user-initiated disconnects and network failures
- **Network Status Monitoring**: Track online/offline status and adjust behavior accordingly
- **Event-Driven Architecture**: Rich event system for monitoring connection lifecycle

### ⚡ Performance Optimizations
- **Efficient Backoff Calculation**: Pre-calculated exponential backoff with maximum exponent limits
- **Memory Management**: Automatic cleanup of resources and timeouts
- **Stream-Based Architecture**: Uses WritableStream for efficient message handling
- **Smart Network Handling**: Avoids unnecessary reconnection attempts when offline

## Usage

### Basic Setup

```typescript
import { WebSocketConnection } from "./connection";

const connection = new WebSocketConnection({
  url: "ws://localhost:8080",
  maxReconnectAttempts: 10,
  initialReconnectDelay: 100, // Start with 100ms
  maxBackoffTime: 30000, // Max 30 seconds between attempts
  connectionTimeout: 10_000, // Fail if WebSocket doesn't open within 10s (default)
  minUptime: 5000, // Reset backoff only after connection stable 5s (optional)
});
```

### Event Handling

```typescript
// Connection state changes
connection.on("update", (state) => {
  console.log("Connection state:", state.type);
});

// Successful connections
connection.on("open", () => {
  console.log("WebSocket connected");
});

// Reconnection attempts
connection.on("retry", (attempt, delay) => {
  console.log(`Reconnection attempt ${attempt} in ${delay}ms`);
});

// Successful reconnections
connection.on("reconnect", () => {
  console.log("WebSocket reconnected");
});

// Network status changes
connection.on("online", () => {
  console.log("Device is online - attempting to reconnect");
});

connection.on("offline", () => {
  console.log("Device is offline - pausing reconnection attempts");
});

// Messages
connection.on("message", (message) => {
  console.log("Received:", message);
});

// Errors
connection.on("error", (error) => {
  console.error("WebSocket error:", error.message);
});
```

### Message Sending with Buffering

```typescript
// Messages are automatically buffered if connection is not ready
connection.send(message);

// Check buffered message count
const bufferedCount = connection.messageBuffer.length;
if (bufferedCount > 0) {
  console.log(`${bufferedCount} messages are buffered`);
}
```

### Connection Management

```typescript
// Wait for connection to be ready
await connection.connected;

// Check connection status
console.log("Manually disconnected:", connection.disconnected);
console.log("Device is online:", connection.isOnline);
console.log("Last connection:", connection.lastConnection);
console.log("Buffered messages:", connection.messageBuffer.length);

// Manual disconnect (prevents reconnection)
connection.disconnect();

// Complete cleanup
connection.destroy();
```

### Network Status Handling

```typescript
// Listen for network changes
connection.on("online", () => {
  console.log("Network is back online!");
  // Connection will automatically attempt to reconnect
});

connection.on("offline", () => {
  console.log("Network is offline - reconnection attempts paused");
  // Show offline indicator to user
});

// Check current network status
if (connection.isOnline) {
  console.log("Device is currently online");
} else {
  console.log("Device is currently offline");
}
```

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `url` | `string` | - | WebSocket server URL |
| `protocols` | `string[]` | `[]` | WebSocket protocols |
| `connect` | `boolean` | `true` | Auto-connect on instantiation |
| `maxReconnectAttempts` | `number` | `10` | Maximum reconnection attempts |
| `initialReconnectDelay` | `number` | `100` | Initial delay in milliseconds |
| `maxBackoffTime` | `number` | `30000` | Maximum backoff time in milliseconds |
| `messageBufferSize` | `number` | `100` | Maximum buffered messages |

## Exponential Backoff Algorithm

The reconnection delay follows the exponential backoff formula:
```
delay = base * 2^attempt
```

Where:
- `base` is the `initialReconnectDelay`
- `attempt` is the current reconnection attempt (0-based)
- The delay is capped at `maxBackoffTime`

Example progression with `initialReconnectDelay: 100` and `maxBackoffTime: 30000`:
- Attempt 1: 100ms
- Attempt 2: 200ms
- Attempt 3: 400ms
- Attempt 4: 800ms
- Attempt 5: 1600ms
- Attempt 6: 3200ms
- Attempt 7: 6400ms
- Attempt 8: 12800ms
- Attempt 9: 25600ms
- Attempt 10: 30000ms (capped)

## Smart Network Handling

The connection manager intelligently handles network status changes:

### When Device Goes Offline:
- **Pauses Reconnection**: Stops all pending reconnection attempts
- **Cancels Timeouts**: Clears any scheduled reconnection timeouts
- **Emits Event**: Fires `offline` event for UI updates
- **Maintains Buffer**: Continues to buffer outgoing messages

### When Device Comes Back Online:
- **Resets Backoff**: Resets exponential backoff counter
- **Attempts Reconnection**: Immediately tries to reconnect
- **Emits Event**: Fires `online` event for UI updates
- **Sends Buffered Messages**: Automatically sends any buffered messages

## State Types

```typescript
type WebsocketState =
  | { type: "offline"; ws: null }
  | { type: "connecting"; ws: WebSocket }
  | { type: "connected"; ws: WebSocket }
  | { type: "error"; ws: WebSocket | null; error: Error; reconnectAttempt: number }
```

## Events

| Event | Parameters | Description |
|-------|------------|-------------|
| `update` | `state: WebsocketState` | Connection state changed |
| `message` | `message: BinaryMessage` | Message received |
| `close` | `event: CloseEvent` | Connection closed |
| `open` | - | Connection opened |
| `error` | `error: Error` | Error occurred |
| `reconnect` | - | Successfully reconnected |
| `retry` | `attempt: number, delay: number` | Reconnection attempt scheduled |
| `online` | - | Device came back online |
| `offline` | - | Device went offline |

## Public Properties

| Property | Type | Description |
|----------|------|-------------|
| `state` | `WebsocketState` | Current connection state |
| `isOnline` | `boolean` | Whether device is currently online |
| `disconnected` | `boolean` | Whether connection was manually disconnected |
| `lastConnection` | `Date \| undefined` | Timestamp of last successful connection |
| `messageBuffer` | `readonly BinaryMessage[]` | Array of buffered messages |
| `connected` | `Promise<void>` | Promise that resolves when connected |

## Best Practices

1. **Handle Network Events**: Listen to `online` and `offline` events for better UX
2. **Monitor Buffer Size**: Check `messageBuffer.length` to prevent memory issues
3. **Graceful Shutdown**: Use `disconnect()` for user-initiated disconnects, `destroy()` for cleanup
4. **Error Recovery**: Implement application-level error recovery based on error events
5. **Connection Health**: Monitor `lastConnection` and network status for health checks
6. **UI Feedback**: Show offline indicators when `isOnline` is false

## Migration from Previous Version

The enhanced connection manager is backward compatible with the following improvements:

- **New Constructor Options**: Additional configuration options for reconnection behavior
- **New Events**: `retry`, `online`, `offline` events for comprehensive monitoring
- **New Properties**: `isOnline`, `disconnected`, `messageBuffer`, `lastConnection`
- **Enhanced Behavior**: Automatic message buffering, smart network handling, and improved reconnection logic

Existing code will continue to work without changes, but can be enhanced by using the new features.
