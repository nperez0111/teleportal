# HTTP Server

This module provides HTTP server functionality for Teleportal, enabling real-time communication between clients and the server using HTTP requests and Server-Sent Events (SSE). It supports both streaming (SSE) and request-response (HTTP) patterns for message exchange.

## Overview

The HTTP server module provides the following endpoints that allow clients to interact with the Teleportal `Server`:

1. **GET `/sse`** - Server-Sent Events endpoint for streaming messages from server to client
2. **POST `/sse`** - HTTP endpoint for pushing messages to an SSE connection via PubSub
3. **POST `/message`** - Direct HTTP endpoint for request-response message handling
4. **GET `/health`** - Health check endpoint
5. **GET `/metrics`** - Prometheus metrics endpoint
6. **GET `/status`** - Server status endpoint

The module is designed to work with the standard `Request` and `Response` interfaces, making it compatible with any runtime that supports the Fetch API (Node.js, Bun, Cloudflare Workers, Deno, etc.).

## Architecture

The HTTP module uses a combination of Server-Sent Events (SSE) and HTTP POST requests to enable bidirectional communication:

```text
┌─────────────────────────────────────────────────────────────────┐
│                    HTTP Communication Patterns                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Pattern 1: SSE Streaming (GET /sse)                            │
│  ┌─────────────┐                                                │
│  │   Client    │ ──GET /sse───────────────────────┐             │
│  └─────────────┘                                  │             │
│                                                   ▼            │
│                                            ┌──────────────┐     │
│                                            │ SSE Reader   │     │
│                                            │  Endpoint    │     │
│                                            └──────────────┘     │
│                                                     │           │
│                                                     │ Messages  │
│                                                     │ (stream)  │
│                                                     ▼          │
│                                            ┌──────────────┐     │
│                                            │   PubSub     │     │
│                                            │  (client/*)  │     │
│                                            └──────────────┘     │
│                                                                 │
│  Pattern 2: HTTP Push to SSE (POST /sse)                        │
│  ┌─────────────┐                                                │
│  │   Client    │ ──POST /sse──────────────────────┐             │
│  └─────────────┘                                  │             │
│                                                    ▼           │
│                                            ┌──────────────┐     │
│                                            │ SSE Writer   │     │
│                                            │  Endpoint    │     │
│                                            └──────────────┘     │
│                                                    │            │
│                                                    │ Publish    │
│                                                    ▼           │
│                                            ┌──────────────┐     │
│                                            │   PubSub     │     │
│                                            │  (client/*)  │     │
│                                            └──────────────┘     │
│                                                    │            │
│                                                    │ Delivered  │
│                                                    │ to SSE     │
│                                                   ▼            │
│                                            ┌──────────────┐     │
│                                            │ SSE Reader   │     │
│                                            │  (GET /sse)  │     │
│                                            └──────────────┘     │
│                                                                 │
│  Pattern 3: Direct HTTP (POST /message)                         │
│  ┌─────────────┐                                                │
│  │   Client    │ ──POST /message───────────────┐                │
│  └─────────────┘                               │                │
│                                               ▼                │
│                                            ┌──────────────┐     │
│                                            │ HTTP         │     │
│                                            │ Endpoint     │     │
│                                            └──────────────┘     │
│                                                 │               │
│                                                 │ Response      │
│                                                 │ (stream)      │
│                                                ▼               │
│                                            ┌──────────────┐     │
│                                            │   Client     │     │
│                                            └──────────────┘     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## API Reference

### `getHTTPHandlers`

Creates a unified HTTP handler that routes requests to the appropriate endpoint based on the HTTP method and path. Routes to GET `/sse`, POST `/sse`, POST `/message`, GET `/health`, GET `/metrics`, and GET `/status`.

**Signature:**

```typescript
function getHTTPHandlers<Context extends ServerContext>({
  server,
  getContext,
  getInitialDocuments,
  fetch: fallbackFetch,
}: {
  server: Server<Context>;
  getContext: (request: Request) => Omit<Context, "clientId"> | Promise<Omit<Context, "clientId">>;
  getInitialDocuments?: (request: Request) => { document: string; encrypted?: boolean }[];
  fetch?: (req: Request) => Response | Promise<Response>;
}): (req: Request) => Response | Promise<Response>;
```

**Parameters:**

- **`server`** (required): The Teleportal `Server` instance to use for managing clients and sessions.

- **`getContext`** (required): A function that extracts the server context from the HTTP request. Can be synchronous or asynchronous. The returned context will be merged with a `clientId` to create the full `Context`.

- **`getInitialDocuments`** (optional): A function that extracts document IDs from the request to automatically subscribe to when establishing an SSE connection. Defaults to `getDocumentsFromQueryParams` which reads from URL query parameters.

- **`fetch`** (optional): A fallback fetch handler for requests that do not match any built-in endpoint. If not provided, unmatched requests return a `404 Not Found` response.

**Returns:**

An async function that takes a `Request` and returns a `Response`. This can be used directly as a fetch handler or integrated into any HTTP server framework.

**Example:**

```typescript
import { getHTTPHandlers } from "teleportal/http";
import { Server } from "teleportal/server";

const server = new Server({
  // ... server configuration
});

const handler = getHTTPHandlers({
  server,
  getContext: async (request) => {
    // Extract user information from headers, cookies, etc.
    const userId = request.headers.get("x-user-id");
    return { userId };
  },
  getInitialDocuments: (request) => {
    // Custom logic to determine initial documents
    return [{ document: "doc-123", encrypted: false }];
  },
});

// Use with any runtime that supports Fetch API
export default {
  fetch: handler,
};
```

### `getSSEReaderEndpoint`

Creates a Server-Sent Events endpoint that streams messages from the server to the client. This endpoint establishes a long-lived connection and streams messages as they become available.

**Signature:**

```typescript
function getSSEReaderEndpoint<Context extends ServerContext>({
  server,
  getContext,
  getInitialDocuments = getDocumentsFromQueryParams,
}: {
  server: Server<Context>;
  getContext: (request: Request) => Omit<Context, "clientId"> | Promise<Omit<Context, "clientId">>;
  getInitialDocuments?: (
    request: Request,
    ctx: {
      clientId: string;
      transport: Transport<Context, { subscribe; unsubscribe }>;
      client: Client<Context>;
    },
  ) => { document: string; encrypted?: boolean }[];
});
```

**How it works:**

1. **Client ID Extraction**: Extracts the client ID from either:
   - `x-teleportal-client-id` header
   - `client-id` query parameter
   - Generates a new UUID if neither is provided

2. **Context Creation**: Merges the extracted/generated `clientId` with the context returned by `getContext()`.

3. **Transport Setup**: Creates an SSE transport that:
   - Subscribes to PubSub topic `client/{clientId}` to receive messages
   - Sends messages to the client via Server-Sent Events
   - Automatically sends ACKs after messages are delivered

4. **Client Creation**: Creates a client on the server with the SSE transport.

5. **Initial Document Subscription**: If `getInitialDocuments` is provided, automatically subscribes to the specified documents.

6. **Connection Management**: When the request is aborted (`req.signal`), the handler unsubscribes from PubSub **and** closes the SSE transport. Closing the transport clears the periodic-ping `setInterval` and ends the response `ReadableStream`, so no timer or consume loop leaks after a client disconnects. `server.createClient` also registers the abort signal and calls `disconnectClient` to remove the client from its sessions.

The SSE stream's **first frame** is an `event:client-id` frame carrying the resolved client ID (the same value returned in the `x-teleportal-client-id` response header), so a client streaming the body — rather than using `EventSource` — learns which id to use for the paired `POST /sse` writer. The reader also emits periodic `event:ping` frames (every 5s) to keep the connection warm.

**Example:**

```typescript
import { getSSEReaderEndpoint } from "teleportal/http";

const sseEndpoint = getSSEReaderEndpoint({
  server,
  getContext: async (request) => {
    return { userId: request.headers.get("x-user-id") };
  },
});

// Documents are encrypted by default; opt one out with a ":plaintext" suffix.
// GET /sse?documents=doc-1,doc-2:plaintext
const response = await sseEndpoint(request);
```

**Client Connection:**

Clients connect using the EventSource API or fetch with streaming:

```typescript
// Using EventSource
const eventSource = new EventSource("/sse?documents=doc-123&client-id=client-456");

eventSource.onmessage = (event) => {
  const message = JSON.parse(event.data);
  // Handle message
};

// Using fetch with streaming
const response = await fetch("/sse?documents=doc-123", {
  headers: {
    "x-teleportal-client-id": "client-456",
  },
});

const reader = response.body?.getReader();
// Read and process messages
```

### `getSSEWriterEndpoint`

Creates an HTTP endpoint that accepts messages via POST and forwards them to an active SSE connection via PubSub. This enables clients to send messages to a server that is streaming to them via SSE.

**Signature:**

```typescript
function getSSEWriterEndpoint<Context extends ServerContext>({
  server,
  getContext,
  ackTimeout = 5000,
}: {
  server: Server<Context>;
  getContext: (request: Request) => Omit<Context, "clientId"> | Promise<Omit<Context, "clientId">>;
  ackTimeout?: number;
});
```

**Parameters:**

- **`server`** (required): The Teleportal `Server` instance.

- **`getContext`** (required): Function to extract context from the request.

- **`ackTimeout`** (optional): Timeout in milliseconds for waiting for ACKs. Defaults to 5000 (5 seconds).

**How it works:**

1. **Client ID Validation**: Requires a client ID to be provided (via header or query parameter). Returns 400 if missing.

2. **Message Reception**: Reads messages from the HTTP request body using `getHTTPSource`.

3. **PubSub Publishing**: Publishes messages to the `client/{clientId}` topic, which the SSE reader endpoint is subscribed to.

4. **ACK Tracking**: Waits for acknowledgment messages from the SSE connection to confirm delivery.

5. **Timeout Handling**: If ACKs are not received within the timeout period, returns a 504 Gateway Timeout response.

**Example:**

```typescript
import { getSSEWriterEndpoint } from "teleportal/http";

const sseWriterEndpoint = getSSEWriterEndpoint({
  server,
  getContext: async (request) => {
    return { userId: request.headers.get("x-user-id") };
  },
  ackTimeout: 10000, // 10 seconds
});

// POST /sse
// Headers: x-teleportal-client-id: client-456
// Body: Message stream
const response = await sseWriterEndpoint(request);
```

**Client Usage:**

```typescript
// Send messages to the SSE connection
const response = await fetch("/sse", {
  method: "POST",
  headers: {
    "x-teleportal-client-id": "client-456",
    "Content-Type": "application/octet-stream",
  },
  body: messageStream,
});

if (response.ok) {
  const result = await response.json();
  // Message delivered successfully
}
```

### `getHTTPEndpoint`

Creates a direct HTTP endpoint that handles messages in a request-response pattern. The client sends messages in the request body and receives a stream of response messages.

**Signature:**

```typescript
function getHTTPEndpoint<Context extends ServerContext>({
  server,
  getContext,
}: {
  server: Server<Context>;
  getContext: (request: Request) => Omit<Context, "clientId"> | Promise<Omit<Context, "clientId">>;
});
```

**How it works:**

1. **Client ID Generation**: Automatically generates a new UUID for each request (stateless).

2. **Message Processing**: Reads messages from the request body and processes them through the server.

3. **Response Streaming**: Returns a `ReadableStream` of `MessageArray`s in the response body.

4. **Connection Management**: Automatically handles request abortion and stream cleanup.

**Example:**

```typescript
import { getHTTPEndpoint } from "teleportal/http";

const httpEndpoint = getHTTPEndpoint({
  server,
  getContext: async (request) => {
    return { userId: request.headers.get("x-user-id") };
  },
});

// POST /message
// Body: Message stream
const response = await httpEndpoint(request);
```

**Client Usage:**

```typescript
// Send messages and receive responses
const response = await fetch("/message", {
  method: "POST",
  headers: {
    "Content-Type": "application/octet-stream",
  },
  body: messageStream,
});

// Read response stream
const reader = response.body?.getReader();
// Process response messages
```

## Utility Functions

### `getDocumentsFromQueryParams`

Default implementation for extracting document IDs from URL query parameters.

**Signature:**

```typescript
function getDocumentsFromQueryParams(request: Request): { document: string; encrypted?: boolean }[];
```

**Supported Formats:**

- Multiple `documents` parameters: `?documents=id-1&documents=id-2`
- Comma-separated values: `?documents=id-1,id-2`
- Plaintext opt-out suffix: `?documents=id-1,id-2:plaintext,id-3:unencrypted`

Documents are **encrypted by default**. Append `:plaintext` (or its alias `:unencrypted`) to a document id to opt that single document out into plaintext. If the same id appears both ways, the encrypted entry wins.

**Example:**

```typescript
// URL: /sse?documents=doc-1,doc-2:plaintext&documents=doc-3
// Returns:
[
  { document: "doc-1", encrypted: true },
  { document: "doc-2", encrypted: false },
  { document: "doc-3", encrypted: true },
];
```

### `decodeHTTPRequest`

Decodes a `Response` containing a stream of `MessageArray`s into a batched async iterable of `Message`s. Throws if the response is missing the `x-teleportal-client-id` header or has no body.

**Signature:**

```typescript
function decodeHTTPRequest(response: Response): AsyncIterable<Message<ClientContext>[]>;
```

**Example:**

```typescript
import { decodeHTTPRequest } from "teleportal/http";

const response = await fetch("/message", {
  method: "POST",
  body: messageStream,
});

const messages = decodeHTTPRequest(response);
// Process individual messages
```

### `getHealthHandler`

Returns a handler that responds with the health status of the server as JSON.

**Signature:**

```typescript
function getHealthHandler(server: Server<any>): (request: Request) => Promise<Response>;
```

Returns the result of `server.getHealth()` as JSON. On error, returns a 500 response with `{ status: "unhealthy", ... }`.

### `getMetricsHandler`

Returns a handler that responds with Prometheus-format metrics.

**Signature:**

```typescript
function getMetricsHandler(server: Server<any>): (request: Request) => Promise<Response>;
```

Returns the result of `server.getMetrics()` as `text/plain`. On error, returns a 500 response.

### `getStatusHandler`

Returns a handler that responds with the server status as JSON.

**Signature:**

```typescript
function getStatusHandler(server: Server<any>): (request: Request) => Promise<Response>;
```

Returns the result of `server.getStatus()` as JSON. On error, returns a 500 response.

### `tokenAuthenticatedHTTPHandler`

Creates a `getHTTPHandlers` instance with token-based authentication. Extracts the token from the `Authorization` header (case-insensitive Bearer scheme) or a `token` query parameter and verifies it using a `TokenManager`. Non-Bearer authorization schemes (e.g. `Basic`) are ignored.

**Signature:**

```typescript
function tokenAuthenticatedHTTPHandler({
  server,
  tokenManager,
  fetch: fallbackFetch,
}: {
  server: Server<ServerContext>;
  tokenManager: TokenManager;
  fetch?: (req: Request) => Response | Promise<Response>;
}): (req: Request) => Response | Promise<Response>;
```

Throws a `Response` with status 401 if no token is provided or if the token is invalid (Bun.serve surfaces thrown `Response` objects as the HTTP response).

The `/health`, `/metrics`, and `/status` endpoints bypass authentication so they remain accessible to monitoring infrastructure (load balancers, Prometheus scrapers, etc.).

**Example:**

```typescript
import { tokenAuthenticatedHTTPHandler } from "teleportal/http";
import { createTokenManager } from "teleportal/token";

const tokenManager = createTokenManager({
  secret: "your-secret-key-here",
});

const httpHandler = tokenAuthenticatedHTTPHandler({
  server,
  tokenManager,
});

Bun.serve({
  fetch: httpHandler,
});
```

## Message Flow

### SSE Pattern (GET + POST /sse)

The SSE pattern enables bidirectional communication using two endpoints:

1. **Client establishes SSE connection** (GET `/sse`):
   - Server creates a client and subscribes to `client/{clientId}` topic
   - Server streams messages to client via SSE
   - Server sends ACKs after messages are delivered

2. **Client sends messages** (POST `/sse`):
   - Client includes `x-teleportal-client-id` header
   - Server publishes messages to `client/{clientId}` topic
   - Messages are delivered to the active SSE connection
   - Server waits for ACKs and returns success/failure

### Direct HTTP Pattern (POST /message)

The direct HTTP pattern provides a simple request-response model:

1. **Client sends request** (POST `/message`):
   - Request body contains message stream
   - Server processes messages and generates responses
   - Response body contains response message stream

2. **Stateless operation**:
   - Each request gets a new client ID
   - No persistent connection required
   - Suitable for one-off operations

## ACK (Acknowledgment) System

Both SSE endpoints use an acknowledgment system to ensure message delivery:

- **SSE Reader**: Automatically sends ACKs after messages are successfully sent to the client via SSE. ACKs are published to `ack/{clientId}` topic.

- **SSE Writer**: Waits for ACKs from the SSE reader before responding. If ACKs are not received within the timeout period, returns a 504 Gateway Timeout.

This ensures reliable message delivery in the SSE pattern.

## Error Handling

The HTTP module includes comprehensive error handling:

- **Missing Client ID**: Returns 400 Bad Request if client ID is required but not provided (SSE writer endpoint).

- **ACK Timeout**: Returns 504 Gateway Timeout if ACKs are not received within the timeout period (SSE writer endpoint).

- **Request Abortion**: When a request is aborted, the SSE reader unsubscribes from PubSub and closes its transport (clearing the ping timer and ending the response stream); the SSE writer's ACK tracking is cancelled and any pending `waitForAcks()` rejects; the direct HTTP endpoint closes its response channel.

- **Unknown Endpoints**: Delegates to the `fetch` fallback handler if provided, otherwise returns 404 Not Found for requests that don't match any endpoint.

## Logging

The module uses structured wide-event logging via `emitWideEvent` from `teleportal/server`. Each endpoint emits a wide event with the following fields:

- `event_type` - One of `"http_sse_reader"`, `"http_sse_writer"`, or `"http_endpoint"`
- `timestamp` - ISO 8601 timestamp
- `client_id` - The client ID for tracing
- `url` - The request URL
- `method` - The HTTP method
- `outcome` - `"success"` or `"error"`
- `status_code` - The HTTP status code
- `duration_ms` - Request duration in milliseconds
- `error` - Error details (when outcome is `"error"`)

## Type Safety

The module is fully typed with TypeScript and extends `ServerContext`:

```typescript
interface ServerContext {
  clientId: string; // Automatically added
  // ... your custom context fields
}
```

The `getContext` function should return `Omit<Context, "clientId">` (synchronously or as a Promise), and the module automatically adds the `clientId` field.

## Integration with Teleportal Server

The HTTP module integrates seamlessly with the Teleportal `Server`:

1. **Client Management**: Automatically calls `server.createClient()` when establishing connections.

2. **Session Management**: Supports automatic document subscription via `getInitialDocuments`.

3. **PubSub Integration**: Uses the server's PubSub instance for message routing between endpoints.

4. **Transport Abstraction**: Uses Teleportal's transport system (`getHTTPSource`, `getSSESink`, `getPubSubSource`, `getPubSubSink`, `withAckSink`, `withAckTrackingSink`, `compose`, `connect`, `createChannel`) for consistent message handling.

## Dependencies

- **`teleportal`**: Core Teleportal types and utilities
- **`teleportal/server`**: Server implementation and wide-event logging
- **`teleportal/transports`**: Transport utilities
- **`teleportal/token`**: JWT token utilities (used by `tokenAuthenticatedHTTPHandler`)
- **`lib0/random`**: UUID generation

## Runtime Compatibility

The HTTP module uses the standard `Request`/`Response` Fetch API, so it is portable to any runtime that implements that interface. Bun is the primary supported runtime.

## Examples

### Basic Setup

```typescript
import { getHTTPHandlers } from "teleportal/http";
import { Server } from "teleportal/server";

const server = new Server({
  // ... server configuration
});

export default {
  fetch: getHTTPHandlers({
    server,
    getContext: async (request) => {
      // Extract context from request
      const authHeader = request.headers.get("Authorization");
      return { userId: extractUserId(authHeader) };
    },
  }),
};
```

### Custom Document Subscription

When using `getHTTPHandlers`, `getInitialDocuments` receives only the `Request`:

```typescript
const handler = getHTTPHandlers({
  server,
  getContext: async (request) => ({ userId: "user-123" }),
  getInitialDocuments: (request) => {
    // Parse document IDs from the request
    const url = new URL(request.url);
    const docId = url.searchParams.get("doc");
    return docId ? [{ document: docId, encrypted: true }] : [];
  },
});
```

When using `getSSEReaderEndpoint` directly, `getInitialDocuments` also receives a context object with the `clientId`, `transport`, and `client`:

```typescript
const sseReader = getSSEReaderEndpoint({
  server,
  getContext: async (request) => ({ userId: "user-123" }),
  getInitialDocuments: (request, ctx) => {
    // Access to client and transport for custom logic
    const userDocs = getUserDocuments(ctx.client.id);
    return userDocs.map((doc) => ({
      document: doc.id,
      encrypted: doc.encrypted,
    }));
  },
});
```

### Using Individual Endpoints

```typescript
import {
  getSSEReaderEndpoint,
  getSSEWriterEndpoint,
  getHTTPEndpoint,
  getHealthHandler,
  getMetricsHandler,
  getStatusHandler,
} from "teleportal/http";

const sseReader = getSSEReaderEndpoint({ server, getContext });
const sseWriter = getSSEWriterEndpoint({ server, getContext });
const httpEndpoint = getHTTPEndpoint({ server, getContext });

export default {
  fetch: async (request: Request) => {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/sse") {
      return await sseReader(request);
    }

    if (request.method === "POST" && url.pathname === "/sse") {
      return await sseWriter(request);
    }

    if (request.method === "POST" && url.pathname === "/message") {
      return await httpEndpoint(request);
    }

    return new Response("Not Found", { status: 404 });
  },
};
```

## Notes

- The SSE reader endpoint maintains a long-lived connection. Ensure your HTTP server/runtime supports long-lived connections.

- The SSE writer endpoint requires an active SSE reader connection for the same client ID. Messages will timeout if no reader is connected.

- The direct HTTP endpoint (`POST /message`) is stateless and generates a new client ID for each request.

- All endpoints support request abortion via `AbortSignal`. When a request is aborted, connections are automatically cleaned up.

- For production use, consider implementing rate limiting, authentication, and request validation in your `getContext` function.
