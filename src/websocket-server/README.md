# WebSocket Server

This module provides WebSocket server functionality for Teleportal, enabling real-time bidirectional communication between clients and the server using the Teleportal binary protocol.

## Overview

The WebSocket server module is built on top of the [`crossws`](https://github.com/wobsoriano/crossws) library, providing a low-level abstraction for WebSocket connections. It handles the conversion between WebSocket messages and Teleportal's `BinaryTransport` interface, allowing seamless integration with the Teleportal `Server`.

## Architecture

The module provides two main functions:

1. **`getWebsocketHandlers`**: A low-level API for creating custom WebSocket handlers
2. **`tokenAuthenticatedWebsocketHandler`**: A high-level wrapper that adds token-based authentication and integrates with the Teleportal `Server`

### Connection Lifecycle

```text
┌─────────────────────────────────────────────────────────────────┐
│                    WebSocket Connection Lifecycle               │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. Upgrade Request                                             │
│     └─> onUpgrade() - Authenticate & extract context            │
│                                                                 │
│  2. Connection Established                                      │
│     └─> open() - Setup BinaryTransport & call onConnect()       │
│                                                                 │
│  3. Message Handling                                            │
│     └─> message() - Decode BinaryMessage & call onMessage()     │
│                                                                 │
│  4. Disconnection                                               │
│     └─> close() - Cleanup & call onDisconnect()                 │
│                                                                 │
│  5. Error Handling                                              │
│     └─> error() - Abort streams & cleanup                       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## API Reference

### `getWebsocketHandlers`

Creates WebSocket handlers using the `crossws` library. This is a low-level API that provides full control over the WebSocket connection lifecycle.

**Signature:**

```typescript
function getWebsocketHandlers<T extends Pick<crossws.PeerContext, "room" | "userId">>({
  onUpgrade,
  onConnect,
  onDisconnect,
  onMessage,
}: {
  onUpgrade: (request: Request) => Promise<{
    context: T;
    headers?: Record<string, string>;
  }>;
  onConnect?: (ctx: {
    transport: BinaryTransport;
    context: T;
    id: string;
    peer: crossws.Peer;
  }) => void | Promise<void>;
  onDisconnect?: (ctx: {
    transport: BinaryTransport;
    context: T;
    id: string;
    peer: crossws.Peer;
  }) => void | Promise<void>;
  onMessage?: (ctx: {
    message: BinaryMessage;
    peer: crossws.Peer;
  }) => void | Promise<void>;
}): {
  hooks: crossws.Hooks;
}
```

**Parameters:**

- **`onUpgrade`** (required): Called when a client attempts to upgrade to a WebSocket connection. You can reject the upgrade by throwing a `Response` object. Must return the connection context and optional headers.

- **`onConnect`** (optional): Called when a client successfully connects. Receives the `BinaryTransport`, connection context, client ID, and the `crossws.Peer` object.

- **`onDisconnect`** (optional): Called when a client disconnects. Receives the same context as `onConnect`.

- **`onMessage`** (optional): Called when a message is received from a client. Receives the decoded `BinaryMessage` and the `crossws.Peer` object.

**Returns:**

An object containing `crossws.Hooks` that can be passed to the `crossws()` function.

**Example:**

```typescript
import { crossws } from "crossws";
import { getWebsocketHandlers } from "teleportal/websocket-server";

const ws = crossws(
  getWebsocketHandlers({
    onUpgrade: async (request) => {
      // Extract authentication from request
      const auth = request.headers.get("Authorization");
      if (!auth) {
        throw new Response("Unauthorized", { status: 401 });
      }

      // Return context for the connection
      return {
        context: {
          userId: "user-123",
          room: "room-456",
        },
        headers: {
          "x-custom-header": "value",
        },
      };
    },
    onConnect: async (ctx) => {
      console.log(`Client ${ctx.id} connected`);
      // Setup your client here
    },
    onDisconnect: async (ctx) => {
      console.log(`Client ${ctx.id} disconnected`);
      // Cleanup your client here
    },
    onMessage: async (ctx) => {
      console.log(`Received message from ${ctx.peer.id}`);
      // Handle message here
    },
  }),
);
```

### `tokenAuthenticatedWebsocketHandler`

A high-level wrapper around `getWebsocketHandlers` that implements token-based authentication and integrates with the Teleportal `Server`. This is the recommended way to set up WebSocket connections for most use cases.

**Signature:**

```typescript
function tokenAuthenticatedWebsocketHandler<T extends ServerContext>({
  server,
  tokenManager,
  hooks = {},
}: {
  server: Server<T>;
  tokenManager: TokenManager;
  hooks?: Partial<Parameters<typeof getWebsocketHandlers>[0]>;
}): ReturnType<typeof getWebsocketHandlers>
```

**Parameters:**

- **`server`** (required): The Teleportal `Server` instance to use for managing clients and sessions.

- **`tokenManager`** (required): A `TokenManager` instance (from `teleportal/token`) used to verify authentication tokens.

- **`hooks`** (optional): Partial hooks object that allows you to extend or override the default behavior. You can provide custom `onUpgrade`, `onConnect`, `onDisconnect`, or `onMessage` handlers.

**Returns:**

The same return type as `getWebsocketHandlers` - an object with `crossws.Hooks`.

**How it works:**

1. **Token Authentication**: Extracts the `token` query parameter from the WebSocket upgrade request URL and verifies it using the `TokenManager`.

2. **Context Extraction**: The token payload is used as the connection context (must include `room` and `userId` fields).

3. **Client Management**: Automatically calls `server.createClient()` when a client connects and `server.disconnectClient()` when a client disconnects.

4. **Transport Conversion**: Converts the `BinaryTransport` to a `Transport` using `fromBinaryTransport()` before passing it to the server.

**Example:**

```typescript
import { crossws } from "crossws";
import { tokenAuthenticatedWebsocketHandler } from "teleportal/websocket-server";
import { createTokenManager } from "teleportal/token";
import { Server } from "teleportal/server";

// Create token manager
const tokenManager = createTokenManager({
  secret: process.env.TOKEN_SECRET!,
});

// Create server
const server = new Server({
  // ... server configuration
});

// Create WebSocket handler
const ws = crossws(
  tokenAuthenticatedWebsocketHandler({
    server,
    tokenManager,
    hooks: {
      // Optional: Add custom logic
      onConnect: async (ctx) => {
        console.log(`Client ${ctx.id} connected to room ${ctx.context.room}`);
      },
    },
  }),
);

// Use with your HTTP server
export default {
  fetch: ws,
};
```

**Client Connection:**

Clients connect by including a token in the WebSocket URL:

```typescript
const token = await tokenManager.createToken({
  userId: "user-123",
  room: "room-456",
});

const ws = new WebSocket(`wss://your-server.com/ws?token=${token}`);
```

## BinaryTransport Integration

The WebSocket server uses `BinaryTransport` as the interface for message exchange. A `BinaryTransport` consists of:

- **`readable: ReadableStream<BinaryMessage>`**: Stream of incoming binary messages
- **`writable: WritableStream<BinaryMessage>`**: Stream for sending binary messages

The module automatically:

1. **Converts WebSocket messages to BinaryTransport**: Uses a `TransformStream` to bridge between WebSocket's `uint8Array()` messages and `BinaryMessage` objects.

2. **Validates messages**: Checks that incoming messages are valid `BinaryMessage` instances using `isBinaryMessage()`.

3. **Handles message flow**: Messages received from the client are written to the transport's readable stream, and messages written to the transport's writable stream are sent to the client via WebSocket.

## Error Handling

The WebSocket server includes comprehensive error handling:

- **Upgrade Rejection**: If `onUpgrade` throws a `Response`, it's returned to the client. Other errors result in a 401 Unauthorized response.

- **Connection Errors**: Errors during `onConnect` are logged and the connection is closed.

- **Message Errors**: Errors during message processing are logged and the message writer is aborted.

- **Stream Errors**: Errors in the transport streams are caught and logged, with streams properly aborted.

## Logging

The module uses structured logging via `@logtape/logtape` with the namespace `["teleportal", "websocket-server"]`. Logs include:

- Connection lifecycle events (upgrade, open, close)
- Message processing
- Error details with context
- Client IDs for tracing

## Type Safety

The module extends `crossws.PeerContext` with additional fields:

```typescript
interface PeerContext {
  room: string;
  userId: string;
  clientId: string;
  transport: BinaryTransport;
  writer: WritableStreamDefaultWriter<BinaryMessage>;
}
```

These fields are automatically populated during the connection lifecycle and are available in all hook callbacks.

## Integration with Teleportal Server

When using `tokenAuthenticatedWebsocketHandler`, the WebSocket server automatically:

1. **Creates clients**: Calls `server.createClient()` with the converted transport when a client connects.

2. **Manages client lifecycle**: The server handles all client state, session management, and message routing.

3. **Disconnects clients**: Calls `server.disconnectClient()` when a client disconnects, ensuring proper cleanup.

4. **Converts transports**: Uses `fromBinaryTransport()` to convert the WebSocket `BinaryTransport` to the `Transport` interface expected by the server.

## Dependencies

- **`crossws`**: WebSocket library (not bundled, must be installed separately)
- **`teleportal`**: Core Teleportal types and utilities
- **`@logtape/logtape`**: Structured logging

## Notes

- The `crossws` library is not bundled with this module. You must install it separately: `npm install crossws` or `bun add crossws`.

- The module is designed to work with any runtime that supports WebSockets (Node.js, Bun, Cloudflare Workers, etc.) through the `crossws` abstraction.

- For production use, always use `tokenAuthenticatedWebsocketHandler` rather than `getWebsocketHandlers` directly, unless you need custom authentication logic.
