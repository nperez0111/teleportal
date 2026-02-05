# Provider & Connection Architecture

This document explains the public interfaces of the `Provider` and `Connection` classes and how they interact with each other.

## Overview

The provider system is built on two main abstractions:

- **`Connection`**: Manages the low-level network connection (WebSocket, HTTP, or fallback), handles reconnection logic, message buffering, and connection state.
- **`Provider`**: Manages Yjs document synchronization, awareness, offline persistence, and milestone operations. It uses a `Connection` for network communication.

## Connection

The `Connection` class is an abstract base class that manages connection state, reconnection logic, message buffering, and in-flight message tracking.

### Public Interface

#### Properties

- **`state: ConnectionState<Context>`** (getter)
  - Returns the current connection state: `connected`, `disconnected`, `connecting`, or `errored`
  - The state includes context information specific to the connection type

- **`destroyed: boolean`**
  - Whether the connection has been destroyed
  - Once destroyed, the connection cannot be reused

- **`inFlightMessageCount: number`** (getter)
  - The number of in-flight messages (excluding awareness messages)

- **`connected: Promise<void>`** (getter)
  - A promise that resolves when the connection is established
  - Automatically invalidated when the connection disconnects or errors
  - Returns a fresh promise for each connection attempt

#### Methods

- **`async send(message: Message): Promise<void>`**
  - Sends a message to the server
  - Messages are buffered if the connection is not yet connected
  - Returns when the message has been queued (not necessarily delivered)

- **`async connect(): Promise<void>`**
  - Explicitly connects the connection
  - Resets reconnection state and attempts to connect
  - Returns a promise that resolves when connected

- **`async disconnect(): Promise<void>`**
  - Explicitly disconnects the connection
  - Prevents automatic reconnection until `connect()` is called again
  - Clears any pending reconnection attempts

- **`async destroy(): Promise<void>`**
  - Permanently destroys the connection
  - Cleans up all resources, timers, and listeners
  - Cannot be reused after destruction

- **`getReader(): FanOutReader<RawReceivedMessage>`**
  - Returns a reader for receiving messages from the connection
  - Multiple readers can be created (fan-out pattern)
  - Used by `Provider` to receive messages

#### Events

The `Connection` class extends `Observable` and emits the following events:

- **`update: (state: ConnectionState<Context>) => void`**
  - Emitted whenever the connection state changes

- **`message: (message: Message) => void`**
  - Emitted when a message is received from the server

- **`connected: () => void`**
  - Emitted when the connection is established

- **`disconnected: () => void`**
  - Emitted when the connection is disconnected

- **`ping: () => void`**
  - Emitted when a ping/heartbeat is received from the server

- **`messages-in-flight: (hasInFlight: boolean) => void`**
  - Emitted when the in-flight message status changes
  - `false` means all messages have been acknowledged

### Connection Implementations

- **`WebSocketConnection`**: WebSocket-based connection
- **`HttpConnection`**: HTTP/SSE-based connection
- **`FallbackConnection`**: Tries WebSocket first, falls back to HTTP if WebSocket fails

### Connection Options

```typescript
type ConnectionOptions = {
  connect?: boolean; // Auto-connect on creation (default: true)
  maxReconnectAttempts?: number; // Max reconnection attempts (default: 10)
  initialReconnectDelay?: number; // Initial backoff delay in ms (default: 100)
  maxBackoffTime?: number; // Max backoff time in ms (default: 30000)
  eventTarget?: EventTarget; // For online/offline events
  isOnline?: boolean; // Initial online state (default: true)
  heartbeatInterval?: number; // Heartbeat interval in ms (default: 0 = disabled)
  messageReconnectTimeout?: number; // Timeout if no messages received (default: 30000)
  minUptime?: number; // Min ms connection must stay open before resetting backoff (default: 0)
  reconnectDelayJitter?: number; // Max random ms added to reconnect delay to avoid thundering herd (default: 0)
  maxBufferedMessages?: number; // Cap on buffered messages when disconnected; over cap are dropped (default: Infinity)
  reconnectBackoffFactor?: number; // Backoff growth factor, delay = initialReconnectDelay * factor^attempt (default: 2)
  timer?: Timer; // Timer implementation for testing
};
```

### Connection States

```typescript
type ConnectionState<Context> =
  | { type: "connected"; context: Context["connected"] }
  | { type: "disconnected"; context: Context["disconnected"] }
  | { type: "connecting"; context: Context["connecting"] }
  | { type: "errored"; context: Context["errored"]; error: Error };
```

## Provider

The `Provider` class manages Yjs document synchronization, awareness, offline persistence, and milestone operations. It wraps a `Connection` and handles the higher-level document synchronization protocol.

### Public Interface

#### Properties

- **`doc: Y.Doc`**
  - The Yjs document being synchronized
  - Direct access to the Yjs document for reading/writing

- **`awareness: Awareness`**
  - The awareness instance for presence/cursor information
  - Shared across the document and subdocuments

- **`transport: T`**
  - The transport instance used for document synchronization
  - Can be customized via `getTransport` option

- **`document: string`**
  - The document ID being synchronized

- **`subdocs: Map<string, Provider>`**
  - Map of subdocument providers (for Yjs subdocuments)
  - Automatically managed when subdocuments are loaded/unloaded

- **`state: ConnectionState`** (getter)
  - Delegates to the underlying connection's state
  - Provides access to connection state without direct connection access

- **`connectionType: "websocket" | "http" | null`** (getter)
  - Returns the active connection type if using `FallbackConnection`
  - Returns `null` for other connection types

#### Getters (Promises)

- **`loaded: Promise<void>`**
  - Resolves when the document is loaded
  - If offline persistence is enabled, waits for local storage to load
  - Otherwise, resolves when `synced` resolves

- **`synced: Promise<void>`**
  - Resolves when:
    1. The underlying connection is connected
    2. The transport is ready (Yjs sync complete)
    3. There are no in-flight messages (excluding awareness)
  - Automatically invalidated when connection disconnects or errors
  - Returns a fresh promise for each sync attempt

#### Methods

- **`static async create<T>(options): Promise<Provider<T>>`**
  - Factory method to create a new provider
  - By default, creates a `FallbackConnection` (WebSocket with HTTP fallback)
  - Can accept a custom `Connection` instance via `client` option
  - Waits for connection to be established before returning

- **`switchDocument(options): Provider<T>`**
  - Switches to a new document, destroying the current provider instance
  - **Lifecycle:**
    - Destroys current provider (Y.Doc, listeners, persistence)
    - Preserves and reuses the underlying connection
    - Abandons pending in-flight messages for the old document
    - Creates and returns a new provider instance for the new document
  - **Use case:** Efficiently switch between documents while maintaining the same connection

- **`openDocument(options): Provider<T>`**
  - Creates a new provider instance for a new document
  - Does NOT destroy the current provider
  - Shares the same underlying connection
  - Useful for creating subdocument providers

- **`async listMilestones(snapshotIds?: string[]): Promise<Milestone[]>`**
  - Lists all milestones for the current document
  - Optional `snapshotIds` parameter for incremental updates
  - Throws `MilestoneOperationDeniedError` if denied, `MilestoneOperationError` on failure

- **`async getMilestoneSnapshot(milestoneId: string): Promise<MilestoneSnapshot>`**
  - Fetches the snapshot content for a specific milestone
  - Returns the snapshot as a `Uint8Array`
  - Throws errors on failure

- **`async createMilestone(name?: string): Promise<Milestone>`**
  - Creates a new milestone from the current document state
  - Optional name (server auto-generates if not provided)
  - Returns the created milestone instance

- **`async updateMilestoneName(milestoneId: string, name: string): Promise<Milestone>`**
  - Updates the name of an existing milestone
  - Returns the updated milestone instance

- **`destroy({ destroyConnection?, destroyDoc? }): void`**
  - Destroys the provider and cleans up resources
  - Options:
    - `destroyConnection` (default: `true`): Whether to destroy the underlying connection
    - `destroyDoc` (default: `true`): Whether to destroy the Y.Doc
  - Cleans up listeners, persistence, and cached promises

- **`[Symbol.dispose](): void`**
  - Allows using `Provider` with `using` statements (explicit resource management)
  - Calls `destroy()` with default options

#### Events

The `Provider` class extends `Observable` and emits the following events:

- **`load-subdoc: (ctx: { subdoc, provider, document, parentDoc }) => void`**
  - Emitted when a subdocument is loaded
  - Provides access to the subdocument provider

- **`unload-subdoc: (ctx: { subdoc, provider, document, parentDoc }) => void`**
  - Emitted when a subdocument is unloaded
  - The provider is automatically destroyed

### Provider Options

```typescript
type ProviderOptions<T> = {
  client: Connection<any>; // Connection instance (required)
  document: string; // Document ID (required)
  ydoc?: Y.Doc; // Existing Y.Doc (default: new Y.Doc())
  awareness?: Awareness; // Existing Awareness (default: new Awareness(ydoc))
  enableOfflinePersistence?: boolean; // Enable IndexedDB persistence (default: true)
  indexedDBPrefix?: string; // IndexedDB prefix (default: 'teleportal-')
  getTransport?: (ctx) => T; // Custom transport factory
};
```

## How Provider and Connection Interact

### Message Flow

1. **Outgoing Messages (Provider → Server):**

   ```
   Provider.transport.readable → Connection.send() → Server
   ```

   - Provider's transport writes messages to a `WritableStream`
   - This stream pipes to `Connection.send()`
   - Connection buffers messages if not connected, sends when connected

2. **Incoming Messages (Server → Provider):**

   ```
   Server → Connection → Connection.getReader() → Provider.transport.writable
   ```

   - Connection receives messages and emits them via `FanOutReader`
   - Provider creates a reader via `Connection.getReader()`
   - Messages are piped to the transport's `writable` stream
   - Transport processes messages and updates the Y.Doc

### Connection Lifecycle Management

1. **Provider Initialization:**
   - Provider receives a `Connection` instance (or creates one via `Provider.create()`)
   - Provider sets up bidirectional message streams
   - Provider listens to connection events (`connected`, `disconnected`)
   - If connection is already connected, provider immediately initializes

2. **Connection State Changes:**
   - Provider listens to `connection.on("connected")` to initialize sync
   - Provider listens to `connection.on("disconnected")` to emit Yjs sync events
   - Provider's `synced` promise depends on `connection.connected` promise
   - Provider invalidates `synced` promise when connection disconnects/errors

3. **Message Synchronization:**
   - Provider waits for `connection.connected` before sending initial sync message
   - Provider tracks in-flight messages via `connection.inFlightMessageCount`
   - Provider's `synced` promise waits for all in-flight messages to complete

### Connection Reuse

- **Multiple Providers, One Connection:**
  - Multiple `Provider` instances can share the same `Connection`
  - Each provider manages its own document and transport
  - Connection handles multiplexing messages to the correct provider

- **Document Switching:**
  - `switchDocument()` destroys the provider but preserves the connection
  - New provider instance reuses the same connection
  - Avoids connection overhead when switching documents

### Error Handling

- **Connection Errors:**
  - Connection emits `errored` state with error details
  - Provider's `synced` promise rejects on connection errors
  - Connection automatically attempts reconnection (if configured)

- **Milestone Operation Errors:**
  - `MilestoneOperationDeniedError`: Operation denied by server (auth/permission)
  - `MilestoneOperationError`: Network or other errors during operation

## Usage Examples

### Basic Usage

```typescript
import { Provider } from "teleportal/providers";

// Create a provider with automatic connection
const provider = await Provider.create({
  url: "wss://example.com",
  document: "my-document-id",
});

// Wait for document to be loaded and synced
await provider.loaded;
await provider.synced;

// Access the Yjs document
const ymap = provider.doc.getMap("data");
ymap.set("key", "value");

// Listen to connection state
provider.on("update", (state) => {
  console.log("Connection state:", state.type);
});
```

### Custom Connection

```typescript
import { Provider } from "teleportal/providers";
import { WebSocketConnection } from "teleportal/providers/websocket";

// Create a custom connection
const connection = new WebSocketConnection({
  url: "wss://example.com",
  connect: false, // Don't auto-connect
});

// Create provider with custom connection
const provider = new Provider({
  client: connection,
  document: "my-document-id",
});

// Manually connect
await connection.connect();
await provider.synced;
```

### Document Switching

```typescript
// Switch to a new document (reuses connection)
const newProvider = provider.switchDocument({
  document: "new-document-id",
});

// Old provider is destroyed, new provider is ready
await newProvider.synced;
```

### Milestone Operations

```typescript
// List milestones (optionally include deleted ones)
const milestones = await provider.listMilestones({ includeDeleted: true });

// Create a milestone
const milestone = await provider.createMilestone("Checkpoint 1");

// Get milestone snapshot
const snapshot = await milestone.fetchSnapshot();

// Update milestone name
await provider.updateMilestoneName(milestone.id, "Updated Name");

// Soft delete milestone
await provider.deleteMilestone(milestone.id);

// Restore milestone
await provider.restoreMilestone(milestone.id);
```

### Subdocuments

```typescript
// Listen to subdocument events
provider.on("load-subdoc", ({ subdoc, provider: subdocProvider }) => {
  console.log("Subdocument loaded:", subdoc.guid);
  // subdocProvider is a Provider instance for the subdocument
});

// Access subdocuments
const subdocProvider = provider.subdocs.get("subdoc-guid");
if (subdocProvider) {
  await subdocProvider.synced;
}
```

### Offline Persistence

```typescript
// Provider automatically enables offline persistence by default
const provider = await Provider.create({
  url: "wss://example.com",
  document: "my-document-id",
  enableOfflinePersistence: true, // default
  indexedDBPrefix: "my-app-", // custom prefix
});

// Document will be loaded from IndexedDB if available
await provider.loaded; // Resolves when local data is loaded
await provider.synced; // Resolves when synced with server
```

### Connection State Monitoring

```typescript
// Monitor connection state
const connection = provider.state;

if (connection.type === "connected") {
  console.log("Connected!");
} else if (connection.type === "errored") {
  console.error("Connection error:", connection.error);
}

// Wait for connection
try {
  await provider.synced;
  console.log("Fully synced!");
} catch (error) {
  console.error("Sync failed:", error);
}
```

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                         Provider                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │   Y.Doc      │  │  Awareness   │  │  Transport   │       │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘       │
│         │                 │                 │               │
│         └─────────────────┴─────────────────┘               │
│                            │                                │
│                            ▼                               │
│                   ┌─────────────────┐                       │
│                   │  Message Stream │                       │
│                   └────────┬────────┘                       │
└────────────────────────────┼────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                      Connection                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │   State      │  │    Buffer    │  │  Reconnect   │       │
│  │  Management  │  │   Messages   │  │   Logic      │       │
│  └──────────────┘  └──────────────┘  └──────────────┘       │
│                            │                                │
│                            ▼                               │
│              ┌───────────────────────────┐                  │
│              │  WebSocket/HTTP/SSE       │                  │
│              └───────────────────────────┘                  │
└─────────────────────────────────────────────────────────────┘
                             │
                             ▼
                        Server
```

## Key Design Decisions

1. **Separation of Concerns:**
   - `Connection` handles network concerns (reconnection, buffering, state)
   - `Provider` handles document concerns (Yjs sync, awareness, persistence)

2. **Connection Reuse:**
   - Connections can be shared across multiple providers
   - Enables efficient document switching without connection overhead

3. **Promise Caching:**
   - `connected` and `synced` promises are cached and invalidated appropriately
   - Prevents memory leaks from accumulating listeners
   - Ensures fresh promises for new connection attempts

4. **Event-Driven Architecture:**
   - Both classes extend `Observable` for event-driven communication
   - Loose coupling between components

5. **Dependency Injection:**
   - Timer abstraction allows mocking in tests
   - Transport factory allows custom transport implementations
   - Connection can be injected for testing or custom implementations
