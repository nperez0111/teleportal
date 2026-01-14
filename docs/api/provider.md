# Provider API

Complete API reference for the Teleportal client provider.

## Provider

The main provider class that manages Y.js document synchronization.

### Static Methods

#### `Provider.create(options)`

Factory method to create a new provider with automatic connection.

```typescript
static create<T>(options: ProviderCreateOptions): Promise<Provider<T>>
```

### Constructor

```typescript
new Provider<T>(options: ProviderOptions<T>)
```

### Options

```typescript
interface ProviderOptions<T> {
  // Required: Connection instance
  client: Connection<any>;

  // Required: Document ID
  document: string;

  // Optional: Existing Y.Doc instance
  ydoc?: Y.Doc;

  // Optional: Existing Awareness instance
  awareness?: Awareness;

  // Optional: Enable offline persistence (default: true)
  enableOfflinePersistence?: boolean;

  // Optional: IndexedDB prefix (default: 'teleportal-')
  indexedDBPrefix?: string;

  // Optional: Custom transport factory
  getTransport?: (ctx) => T;
}
```

### Properties

- `doc: Y.Doc` - The Y.js document being synchronized
- `awareness: Awareness` - The awareness instance for presence/cursor information
- `transport: T` - The transport instance
- `document: string` - The document ID being synchronized
- `subdocs: Map<string, Provider>` - Map of subdocument providers
- `state: ConnectionState` - Current connection state (getter)
- `connectionType: "websocket" | "http" | null` - Active connection type (getter)

### Getters (Promises)

- `loaded: Promise<void>` - Resolves when the document is loaded
- `synced: Promise<void>` - Resolves when the document is synced

### Methods

#### `switchDocument(options)`

Switches to a new document, destroying the current provider instance.

```typescript
switchDocument(options: {
  document: string;
  ydoc?: Y.Doc;
  awareness?: Awareness;
}): Provider<T>
```

#### `openDocument(options)`

Creates a new provider instance for a new document without destroying the current one.

```typescript
openDocument(options: {
  document: string;
  ydoc?: Y.Doc;
  awareness?: Awareness;
}): Provider<T>
```

#### `listMilestones(snapshotIds?)`

Lists all milestones for the current document.

```typescript
listMilestones(snapshotIds?: string[]): Promise<Milestone[]>
```

#### `getMilestoneSnapshot(milestoneId)`

Fetches the snapshot content for a specific milestone.

```typescript
getMilestoneSnapshot(milestoneId: string): Promise<MilestoneSnapshot>
```

#### `createMilestone(name?)`

Creates a new milestone from the current document state.

```typescript
createMilestone(name?: string): Promise<Milestone>
```

#### `updateMilestoneName(milestoneId, name)`

Updates the name of an existing milestone.

```typescript
updateMilestoneName(milestoneId: string, name: string): Promise<Milestone>
```

#### `destroy(options?)`

Destroys the provider and cleans up resources.

```typescript
destroy(options?: {
  destroyConnection?: boolean; // default: true
  destroyDoc?: boolean;        // default: true
}): void
```

### Events

The `Provider` class extends `Observable` and emits the following events:

- `load-subdoc: (ctx: { subdoc, provider, document, parentDoc }) => void` - Emitted when a subdocument is loaded
- `unload-subdoc: (ctx: { subdoc, provider, document, parentDoc }) => void` - Emitted when a subdocument is unloaded
- `update: (state: ConnectionState) => void` - Emitted when connection state changes

## Connection

The connection interface for network communication.

### Properties

- `state: ConnectionState<Context>` - Current connection state (getter)
- `destroyed: boolean` - Whether the connection has been destroyed
- `inFlightMessageCount: number` - Number of in-flight messages (getter)
- `connected: Promise<void>` - Promise that resolves when connected (getter)

### Methods

#### `send(message)`

Sends a message to the server.

```typescript
send(message: Message): Promise<void>
```

#### `connect()`

Explicitly connects the connection.

```typescript
connect(): Promise<void>
```

#### `disconnect()`

Explicitly disconnects the connection.

```typescript
disconnect(): Promise<void>
```

#### `destroy()`

Permanently destroys the connection.

```typescript
destroy(): Promise<void>
```

#### `getReader()`

Returns a reader for receiving messages from the connection.

```typescript
getReader(): FanOutReader<RawReceivedMessage>
```

### Events

- `update: (state: ConnectionState<Context>) => void` - Emitted when connection state changes
- `message: (message: Message) => void` - Emitted when a message is received
- `connected: () => void` - Emitted when connection is established
- `disconnected: () => void` - Emitted when connection is disconnected
- `ping: () => void` - Emitted when a ping/heartbeat is received
- `messages-in-flight: (hasInFlight: boolean) => void` - Emitted when in-flight message status changes

## Examples

See the [Provider Setup Guide](../../guide/provider-setup.md) for complete examples.
