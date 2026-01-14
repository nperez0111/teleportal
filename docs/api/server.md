# Server API

Complete API reference for the Teleportal server.

## Server

The main server class that manages document sessions and client connections.

### Constructor

```typescript
new Server<Context>(options: ServerOptions<Context>)
```

### Options

```typescript
interface ServerOptions<Context> {
  // Required: Function that returns storage for a document
  getStorage: (ctx: {
    documentId: string;
    context: Context;
  }) => Promise<DocumentStorage>;

  // Optional: Permission checking function
  checkPermission?: (ctx: {
    context: Context;
    documentId?: string;
    fileId?: string;
    message: Message;
  }) => Promise<boolean>;

  // Optional: Custom logger
  logger?: Logger;

  // Optional: Enable metrics collection
  enableMetrics?: boolean;
}
```

### Methods

#### `createClient(transport, context, id)`

Creates a new client connection.

```typescript
createClient(
  transport: Transport<Context>,
  context: Context,
  id: string
): Client<Context>
```

#### `disconnectClient(id)`

Disconnects a client and cleans up resources.

```typescript
disconnectClient(id: string): Promise<void>
```

#### `getOrOpenSession(documentId, options)`

Gets an existing session or creates a new one.

```typescript
getOrOpenSession(
  documentId: string,
  options: {
    encrypted: boolean;
    client: Client<Context>;
    context: Context;
  }
): Promise<Session<Context>>
```

#### `getSession(documentId)`

Gets an existing session (returns `null` if not found).

```typescript
getSession(documentId: string): Session<Context> | null
```

## Client

Represents a connected client.

### Properties

- `id: string` - Unique client identifier
- `transport: Transport<Context>` - Transport instance
- `context: Context` - Client context

## Session

Represents a document session with multiple clients.

### Methods

#### `addClient(client)`

Adds a client to the session.

```typescript
addClient(client: Client<Context>): void
```

#### `removeClient(client)`

Removes a client from the session.

```typescript
removeClient(client: Client<Context>): void
```

#### `close()`

Closes the session and cleans up resources.

```typescript
close(): Promise<void>
```

## Transport

The transport interface for bidirectional communication.

### Properties

- `readable: ReadableStream<Message>` - Stream for receiving messages
- `writable: WritableStream<Message>` - Stream for sending messages

## Examples

See the [Server Setup Guide](../../guide/server-setup.md) for complete examples.
