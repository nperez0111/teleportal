# Provider & Connection Architecture

This document explains the public interfaces of the `Provider` and `Connection` classes and how they interact with each other.

## Overview

The provider system is built on two main abstractions:

- **`Connection`**: An interface that manages the low-level network connection, handles reconnection logic, message buffering, and connection state. The default implementation is `DirectConnection`, which takes an ordered list of `ConnectionTransport` instances and tries them in preference order.
- **`Provider`**: Manages Yjs document synchronization, awareness, offline persistence, and RPC operations. It uses a `Connection` for network communication.

## Connection

The `Connection` interface defines the contract for network connections. It is implemented by `DirectConnection` (in-thread) and `WorkerConnection` (SharedWorker proxy).

### Public Interface

#### Properties

- **`hosting: "direct" | "worker"`** (readonly)
  - Where the connection runs: `"direct"` (in-thread) or `"worker"` (SharedWorker)

- **`state: ConnectionState`** (readonly)
  - Returns the current connection state: `connected`, `disconnected`, `connecting`, or `errored`
  - Connected and connecting states include a `transport` string indicating the active transport name

- **`activeTransport: string | null`** (readonly)
  - Name of the currently active transport, or `null` if disconnected

- **`availableTransports: string[]`** (readonly)
  - Names of all registered transports

- **`destroyed: boolean`** (readonly)
  - Whether the connection has been destroyed
  - Once destroyed, the connection cannot be reused

- **`inFlightMessageCount: number`** (readonly)
  - The number of in-flight messages (excluding awareness and ack messages)

- **`connected: Promise<void>`** (getter)
  - A promise that resolves when the connection is established
  - Automatically invalidated when the connection disconnects or errors
  - Returns a fresh promise for each connection attempt

#### Methods

- **`async send(message: Message): Promise<void>`**
  - Sends a message to the server with in-flight tracking and batching
  - Messages are buffered if the connection is not yet connected
  - Doc update messages for the same document are batched (AIMD-controlled interval)

- **`sendStream(message: Message): void`**
  - Fire-and-forget send for high-throughput streams (e.g. file chunks)
  - Skips in-flight tracking and event dispatch for throughput
  - Buffers if not connected so chunks are never silently dropped

- **`getReader(): FanOutReader<RawReceivedMessage>`**
  - Returns a reader for receiving messages from the connection
  - Multiple readers can be created (fan-out pattern)
  - Used by `Provider` to receive messages

- **`async connect(): Promise<void>`**
  - Explicitly connects the connection
  - Resets reconnection state and attempts to connect
  - Returns a promise that resolves when connected

- **`async disconnect(): Promise<void>`**
  - Explicitly disconnects the connection
  - Prevents automatic reconnection until `connect()` is called again
  - Clears any pending reconnection attempts

- **`async switchTransport(name: string): Promise<void>`**
  - Switches to a specific transport by name
  - Throws if the transport name is not in the registered transports list
  - Sets a manual override flag that disables automatic upgrade probing

- **`destroy(): void | Promise<void>`**
  - Permanently destroys the connection
  - Cleans up all resources, timers, and listeners
  - Cannot be reused after destruction

#### Events

The `Connection` interface extends `Observable` and emits the following events:

- **`update: (state: ConnectionState) => void`**
  - Emitted whenever the connection state changes

- **`connected: () => void`**
  - Emitted when the connection is established

- **`disconnected: () => void`**
  - Emitted when the connection is disconnected

- **`ping: () => void`**
  - Emitted when a ping/heartbeat is received from the server

- **`messages-in-flight: (hasInFlight: boolean) => void`**
  - Emitted when the in-flight message status changes
  - `false` means all messages have been acknowledged

- **`sent-message: (message: Message) => void`**
  - Emitted when a message is successfully sent

- **`received-message: (message: Message) => void`**
  - Emitted when a message is received from the server

### DirectConnection

`DirectConnection` is the single connection class. It takes an ordered array of `ConnectionTransport[]` and manages transport selection, fallback, and auto-upgrade:

- **Transport fallback**: On connect, transports are tried in order. If the preferred transport (e.g. WebSocket) fails, the next one (e.g. HTTP) is tried automatically.
- **Upgrade probing**: When connected on a non-preferred transport, `DirectConnection` periodically probes the preferred transport (if it has a `probe()` method). If the probe succeeds, it transparently upgrades back to the preferred transport. Probe interval uses exponential backoff on failure.
- **Manual override**: `switchTransport(name)` forces a specific transport and disables automatic upgrade probing.

### ConnectionTransport Interface

Transports are lightweight objects that implement the `ConnectionTransport` interface:

```typescript
interface ConnectionTransport {
  readonly name: string;
  connect(ctx: TransportConnectContext): Promise<void>;
  send(message: Message): Promise<void>;
  close(): Promise<void>;
  sendHeartbeat?(): void;
  timeout?: number;
  probe?(ctx: { url?: string; token?: string; timer: Timer }): Promise<boolean>;
}
```

Two built-in transport factories are provided:

- **`websocketTransport(options?)`** — WebSocket-based transport. Supports `probe()` for upgrade detection. Options: `timeout` (default 5000ms), `protocols`, `WebSocket` (implementation override).
- **`httpTransport(options?)`** — HTTP/SSE-based transport (SSE for server-to-client, HTTP POST for client-to-server). Options: `timeout` (default 10000ms), `fetch`, `EventSource`, `httpBatchingOptions`.

### ConnectionOptions

```typescript
type ConnectionOptions = {
  url?: string;                      // Server URL
  transports: ConnectionTransport[]; // Ordered list of transports (required)
  token?: TokenOptions;              // Authentication token with auto-refresh
  connect?: boolean;                 // Auto-connect on creation (default: true)
  maxReconnectAttempts?: number;     // Max reconnection attempts (default: 10)
  initialReconnectDelay?: number;    // Initial backoff delay in ms (default: 100)
  maxBackoffTime?: number;           // Max backoff time in ms (default: 30000)
  reconnectBackoffFactor?: number;   // Backoff growth factor (default: 1.3)
  heartbeatInterval?: number;        // Heartbeat interval in ms (default: 0 = disabled)
  messageReconnectTimeout?: number;  // Timeout if no messages received (default: 30000)
  minUptime?: number;                // Min ms before resetting backoff (default: 0)
  reconnectDelayJitter?: number;     // Max random ms added to reconnect delay (default: 0)
  maxBufferedMessages?: number;      // Cap on buffered messages (default: Infinity)
  inFlightMessageTimeout?: number;   // Timeout for in-flight message ACK (default: 30000)
  batchIntervalMs?: number;          // Update batch interval in ms (default: 100)
  maxBatchIntervalMs?: number;       // Max batch interval / AIMD upper bound (default: 5000)
  upgradeProbeInterval?: number;     // Upgrade probe interval in ms (default: 30000)
  maxUpgradeProbeInterval?: number;  // Max probe interval after backoff (default: 300000)
  timer?: Timer;                     // Timer implementation for testing
  eventTarget?: EventTarget;         // For online/offline events
  isOnline?: boolean;                // Initial online state (default: true)
};
```

### TokenOptions

```typescript
interface TokenOptions {
  token: string;
  onTokenExpired?: (currentToken: string) => Promise<string>;
  refreshBeforeExpiryMs?: number;
}
```

### Connection States

```typescript
type ConnectionState =
  | { type: "connected"; transport: string }
  | { type: "disconnected" }
  | { type: "connecting"; transport: string }
  | { type: "errored"; error: Error };
```

## Provider

The `Provider` class manages Yjs document synchronization, awareness, offline persistence, and RPC operations. It wraps a `Connection` and handles the higher-level document synchronization protocol.

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

- **`encryptionKey?: CryptoKey | false`**
  - The encryption key used for end-to-end content encryption, or `false` for plaintext

- **`subdocs: Map<string, Provider>`**
  - Map of subdocument providers (for Yjs subdocuments)
  - Automatically managed when subdocuments are loaded/unloaded

- **`rpc: RpcNamespace<R>`**
  - Namespace object containing initialized RPC extensions

- **`state: ConnectionState`** (getter)
  - Delegates to the underlying connection's state

- **`connection: Connection`** (getter)
  - Direct access to the underlying connection

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

- **`static async create<T, R>(options): Promise<Provider<T, R>>`**
  - Factory method to create a new provider
  - Accepts either `{ url, transports?, token? }` to create a `DirectConnection`, or `{ connection }` to use an existing connection
  - By default creates a `DirectConnection` with `[websocketTransport({ timeout: 5000 }), httpTransport()]`
  - Resolves `KeyResolver` encryption keys before construction
  - Waits for connection to be established before returning

- **`switchDocument(options): Provider<T, R>`**
  - Switches to a new document, destroying the current provider instance
  - **Lifecycle:**
    - Destroys current provider (Y.Doc, listeners, persistence)
    - Preserves and reuses the underlying connection
    - Abandons pending in-flight messages for the old document
    - Creates and returns a new provider instance for the new document

- **`openDocument(options): Provider<T, R>`**
  - Creates a new provider instance for a new document
  - Does NOT destroy the current provider
  - Shares the same underlying connection
  - Inherits the parent's encryption mode unless explicitly overridden

- **`async openDocumentAsync(options): Promise<Provider<T, R>>`**
  - Like `openDocument`, but resolves `KeyResolver` encryption keys asynchronously
  - Use when the encryption key needs async resolution per document

- **`destroy({ destroyConnection?, destroyDoc? }): void`**
  - Destroys the provider and cleans up resources
  - Options:
    - `destroyConnection` (default: `true`): Whether to destroy the underlying connection
    - `destroyDoc` (default: `true`): Whether to destroy the Y.Doc
  - Cleans up listeners, persistence, and cached promises

- **`async clearOfflineData(): Promise<void>`**
  - Clears persisted offline data for the current document

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

- **`received-message: (message: RawReceivedMessage) => void`**
  - Emitted when a message is received

- **`sent-message: (message: Message) => void`**
  - Emitted when a message is sent

- **`connected: () => void`**
  - Emitted when the connection is established

- **`disconnected: () => void`**
  - Emitted when the connection is disconnected

- **`update: (state: ConnectionState) => void`**
  - Emitted when the connection state changes

- **`peer-join: (peer: PresenceEvent) => void`**
  - Emitted when a peer joins the document

- **`peer-leave: (peer: PresenceEvent) => void`**
  - Emitted when a peer leaves the document

### Provider Options

```typescript
type ProviderOptions<T, R> = {
  connection: Connection;             // Connection instance (required)
  document: string;                   // Document ID (required)
  encryptionKey: CryptoKey | false;   // E2EE key -- required (use `false` for plaintext)
  ydoc?: Y.Doc;                       // Existing Y.Doc (default: new Y.Doc())
  awareness?: Awareness;              // Existing Awareness (default: new Awareness(ydoc))
  enableOfflinePersistence?: boolean;  // Enable IndexedDB persistence (default: true)
  indexedDBPrefix?: string;           // IndexedDB prefix (default: 'teleportal-')
  offlineStorage?: AbstractDocumentStorage; // Custom offline storage backend
  rpc?: R;                            // RPC extension map
  getTransport?: (ctx) => T;          // Custom transport factory
};
```

> **Encryption is the default.** `encryptionKey` is required -- pass a `CryptoKey` (from `createEncryptionKey()` / `importEncryptionKey()` in `teleportal/encryption-key`) to enable content-level end-to-end encryption, or pass `false` to deliberately run a plaintext document. Omitting it throws. The key is never sent to the server; only the plaintext CRDT structure update and the encrypted content sidecars are.
>
> Offline persistence stores the **encrypted wire representation** (content-encrypted payload) to IndexedDB -- data at rest is encrypted for encrypted documents. Plaintext documents (`encryptionKey: false`) are stored inline as-is. Awareness/presence routing IDs (clientID/userId) travel in cleartext even though the awareness payload is encrypted.

## How Provider and Connection Interact

### Message Flow

1. **Outgoing Messages (Provider -> Server):**

   ```
   Provider.transport.source -> Connection.send() -> ActiveTransport -> Server
   ```

   - Provider's transport produces messages via its `source` async iterable
   - These are drained into `Connection.send()`
   - Connection batches doc update messages (AIMD-controlled interval)
   - Connection buffers messages if not connected, sends when connected
   - The active `ConnectionTransport` delivers the message over the wire

2. **Incoming Messages (Server -> Provider):**

   ```
   Server -> ActiveTransport -> Connection -> Connection.getReader() -> Provider.transport.write()
   ```

   - The active `ConnectionTransport` receives messages and calls `onMessage`
   - Connection emits them via `FanOutReader`
   - Provider creates a reader via `Connection.getReader()`
   - Messages are written to the transport's `write()` method
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

- **Token Refresh:**
  - `DirectConnection` schedules automatic token refresh before expiry
  - On token refresh, the connection disconnects and reconnects with the new token
  - Reactive refresh triggers on server `permission denied` responses

## Usage Examples

### Basic Usage

```typescript
import { Provider } from "teleportal/providers";
import { createEncryptionKey } from "teleportal/encryption-key";

// Create a provider with automatic connection.
// By default creates a DirectConnection with [websocketTransport(), httpTransport()]
const provider = await Provider.create({
  url: "wss://example.com",
  document: "my-document-id",
  encryptionKey: await createEncryptionKey(),
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
import { Provider, DirectConnection, websocketTransport, httpTransport } from "teleportal/providers";
import { createEncryptionKey } from "teleportal/encryption-key";

// Create a custom connection with specific transports
const connection = new DirectConnection({
  url: "wss://example.com",
  transports: [websocketTransport({ timeout: 3000 }), httpTransport()],
  connect: false, // Don't auto-connect
});

// Create provider with custom connection
const provider = new Provider({
  connection,
  document: "my-document-id",
  encryptionKey: await createEncryptionKey(),
});

// Manually connect
await connection.connect();
await provider.synced;
```

### Custom Transports

```typescript
import { Provider, DirectConnection, websocketTransport } from "teleportal/providers";
import { createEncryptionKey } from "teleportal/encryption-key";

// WebSocket-only (no HTTP fallback)
const connection = new DirectConnection({
  url: "wss://example.com",
  transports: [websocketTransport()],
});

// HTTP-only
import { httpTransport } from "teleportal/providers";
const httpOnlyConnection = new DirectConnection({
  url: "https://example.com",
  transports: [httpTransport()],
});

// Custom transport order or options
const provider = await Provider.create({
  url: "wss://example.com",
  document: "my-document-id",
  encryptionKey: await createEncryptionKey(),
  transports: [websocketTransport({ timeout: 3000 }), httpTransport({ timeout: 15000 })],
});
```

### Document Switching

```typescript
// Switch to a new document (reuses connection)
const newProvider = provider.switchDocument({
  document: "new-document-id",
  encryptionKey: await createEncryptionKey(),
});

// Old provider is destroyed, new provider is ready
await newProvider.synced;
```

### Transport Switching

```typescript
// Check available and active transports
console.log(provider.connection.availableTransports); // ["websocket", "http"]
console.log(provider.connection.activeTransport);     // "websocket"

// Manually switch to HTTP transport
await provider.connection.switchTransport("http");
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
// Provider automatically enables offline persistence by default.
// Encrypted documents are stored at rest in content-encrypted format
// (the same wire format used between client and server).
const provider = await Provider.create({
  url: "wss://example.com",
  document: "my-document-id",
  enableOfflinePersistence: true, // default
  indexedDBPrefix: "my-app-", // custom prefix (names the IndexedDB database)
  encryptionKey: await createEncryptionKey(),
});

// Document will be loaded from IndexedDB if available
await provider.loaded; // Resolves when local data is replayed
await provider.synced; // Resolves when synced with server

// Clear persisted data for this document
await provider.clearOfflineData();
```

The offline storage uses the same `AbstractDocumentStorage` base as the server. By default it is backed by IndexedDB (`IdbDocumentStorage`), but you can inject a custom backend via the `offlineStorage` option:

```typescript
const provider = new Provider({
  connection,
  document: "my-doc",
  encryptionKey: key,
  offlineStorage: myCustomStorage, // any AbstractDocumentStorage
});
```

### Connection State Monitoring

```typescript
// Monitor connection state
const state = provider.state;

if (state.type === "connected") {
  console.log("Connected via:", state.transport);
} else if (state.type === "errored") {
  console.error("Connection error:", state.error);
}

// Check active transport
console.log("Active transport:", provider.connection.activeTransport);

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
+-----------------------------------------------------------------+
|                           Provider                              |
|  +--------------+  +--------------+  +--------------+           |
|  |   Y.Doc      |  |  Awareness   |  |  Transport   |           |
|  +------+-------+  +------+-------+  +------+-------+           |
|         |                 |                 |                    |
|         +-----------------+-----------------+                    |
|                           |                                     |
|                           v                                     |
|                  +-----------------+                             |
|                  |  Message Stream |                             |
|                  +--------+--------+                             |
+---------------------------+-------------------------------------+
                            |
                            v
+-----------------------------------------------------------------+
|                   DirectConnection                              |
|  +--------------+  +--------------+  +--------------+           |
|  |   State      |  |    Buffer    |  |  Reconnect   |           |
|  |  Management  |  |  & Batching  |  |   Logic      |           |
|  +--------------+  +--------------+  +--------------+           |
|                           |                                     |
|              +------------+------------+                        |
|              |                         |                        |
|       +------+-------+         +------+-------+                 |
|       | websocket    |         |    http      |                 |
|       | Transport    |         |  Transport   |                 |
|       +--------------+         +--------------+                 |
+-----------------------------------------------------------------+
                            |
                            v
                        Server
```

## Key Design Decisions

1. **Separation of Concerns:**
   - `Connection` handles network concerns (reconnection, buffering, state, transport selection)
   - `Provider` handles document concerns (Yjs sync, awareness, persistence, RPC)

2. **Pluggable Transports:**
   - Transports are passed as an ordered array to `DirectConnection`
   - Fallback behavior is built into `DirectConnection` -- no separate fallback class needed
   - Custom transports implement `ConnectionTransport` and can be mixed with built-in ones

3. **Connection Reuse:**
   - Connections can be shared across multiple providers
   - Enables efficient document switching without connection overhead

4. **Automatic Upgrade:**
   - When running on a fallback transport, `DirectConnection` probes the preferred transport
   - Transparent upgrade when the preferred transport becomes available
   - Exponential backoff on probe failures to avoid hammering

5. **Promise Caching:**
   - `connected` and `synced` promises are cached and invalidated appropriately
   - Prevents memory leaks from accumulating listeners
   - Ensures fresh promises for new connection attempts

6. **Event-Driven Architecture:**
   - Both classes extend `Observable` for event-driven communication
   - Loose coupling between components

7. **Dependency Injection:**
   - Timer abstraction allows mocking in tests
   - Transport factories allow custom transport implementations
   - Connection can be injected for testing or custom implementations

## SharedWorker Architecture

When running in a browser that supports `SharedWorker`, Teleportal can offload the network connection to a shared worker so that all tabs share a single underlying transport. This is opt-in: pass a `workerUrl` to `createConnection()` (or use `WorkerProvider.create()`). When `SharedWorker` is unavailable or construction fails (CSP, `file://` origin, etc.), the system transparently falls back to a `DirectConnection` in the current thread.

### Connection Sharing Model

The `ConnectionWorkerManager` lives inside the SharedWorker and manages a pool of `ManagedConnection` instances. Each browser tab communicates with the worker over a dedicated `MessagePort`.

When a tab sends an `init` message, the manager computes a **pooling key** from the serialized connection options. By default the key is `url + "::" + token`, so:

- Tabs connecting to the same server with the same token share one underlying `DirectConnection`.
- Different tokens (different users / identities) get separate connections, keeping attribution isolated.

The pooling key function is configurable via `ConnectionWorkerManagerOptions.getConnectionKey`.

### MessagePort Protocol

All communication between the main thread (`WorkerConnection`) and the worker (`ConnectionWorkerManager`) flows through a typed `MessagePort` protocol defined in `protocol.ts`. Messages are split into **upstream** (main thread to worker) and **downstream** (worker to main thread).

#### Generic / transport-level messages

These messages handle connection lifecycle and data transport. They are feature-agnostic and would exist for any sync protocol:

| Direction | Type | Purpose |
|-----------|------|---------|
| upstream | `init` | Initialize connection with serialized options and tab ID |
| upstream | `send` | Send an encoded message (reliable, with ACK tracking) |
| upstream | `send-stream` | Send an encoded message (fire-and-forget stream) |
| upstream | `connect` | Request connection (RPC with request ID) |
| upstream | `disconnect` | Request disconnection (RPC with request ID) |
| upstream | `switch-transport` | Switch active transport (RPC with request ID) |
| upstream | `destroy` | Tear down this tab's port |
| upstream | `network-status` | Forward browser online/offline state |
| upstream | `heartbeat` | Liveness probe |
| downstream | `ready` | Initial state snapshot on connection |
| downstream | `state-update` | Connection state change |
| downstream | `event` | Generic event forwarding (ping, messages-in-flight, sent-message) |
| downstream | `message` | Incoming message from server |
| downstream | `property` | Property snapshot (inFlightMessageCount, destroyed, transports) |
| downstream | `response` | RPC response (success or error, keyed by request ID) |
| downstream | `heartbeat-ack` | Heartbeat response |

#### Feature-specific messages (file operations)

These messages are specific to the file upload/download protocol. They carry domain-specific payloads (`File`, `CryptoKey`, `fileId`, `document`) and have dedicated result/error message types:

| Direction | Type | Purpose |
|-----------|------|---------|
| upstream | `file-upload` | Upload a file (with optional encryption key) |
| upstream | `file-download` | Download a file by ID |
| downstream | `file-upload-result` | Upload succeeded, returns file ID |
| downstream | `file-upload-error` | Upload failed |
| downstream | `file-download-result` | Download succeeded, returns `File` |
| downstream | `file-download-error` | Download failed |

### Grace Period on Last-Tab Disconnect

When the last tab disconnects (sends a `destroy` message), the `ManagedConnection` is not torn down immediately. Instead, a configurable grace period (default 5 seconds) is scheduled. If a new tab connects with the same pooling key before the timer fires, the existing connection is reused and the timer is cancelled. This avoids unnecessary reconnection churn during page reloads or tab switches.

### Event Forwarding

The worker selectively forwards connection events to all attached ports:

- **State events** (`update`) are sent as `state-update` messages. The client-side `WorkerConnection` derives `connected` and `disconnected` events from state transitions rather than forwarding them as generic events, preventing double-firing.
- **Non-state events** (`ping`, `messages-in-flight`) use the generic `event` message type.
- **`sent-message`** requires special handling: `Message` objects cannot survive structured clone, so the worker forwards raw encoded bytes and the client reconstructs the message.

### Network Status Reconciliation

Each port independently forwards browser `online`/`offline` events. The `ManagedConnection` reconciles across all ports: the underlying connection is considered online if **any** attached tab reports online, and offline only when **all** tabs report offline. This prevents a single backgrounded tab from taking the shared connection offline.

### Known Limitation: Hardcoded File Operations

The project has a well-designed extensibility system for RPC operations: `RpcExtension` (for extending the provider's `.rpc` namespace) and `ClientRpcHandler` (a handler registry that the `Provider` routes incoming RPC responses and streams through). File operations use `ClientRpcHandler` when running in a `DirectConnection` on the main thread.

However, the SharedWorker protocol currently hardcodes file upload and download as first-class message types rather than routing them through a generic RPC invocation mechanism. The `ConnectionWorkerManager` directly imports `getFileClientHandlers` from `teleportal/protocols/file` and instantiates a `FileClientHandler` internally. The `WorkerConnection` maintains a separate `#pendingFileOps` map alongside the generic `#pendingRequests` map, with four dedicated message handlers for file results and errors.

This means the worker must know about file transfer internals (chunking, encryption, merkle proofs) that are otherwise encapsulated in the file protocol module. Any new heavy operation that should run in the worker (e.g., a future export or import protocol) would require adding new message types to `UpstreamMessage` and `DownstreamMessage`, new handler branches in `ConnectionWorkerManager.#handleUpstream`, and new result handlers in `WorkerConnection.#handleMessage`.
