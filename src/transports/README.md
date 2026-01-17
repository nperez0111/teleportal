# Transports

The `transports` module provides a composable transport layer system for Teleportal. Transports are the abstraction layer that handles how messages are sent and received between clients and servers, allowing Teleportal to work over various communication protocols and patterns.

## Overview

A **Transport** is a combination of a **Source** (for reading messages) and a **Sink** (for writing messages). The transport system is built on Web Streams API, making it composable and allowing multiple transports to be chained together to add functionality like encryption, rate limiting, logging, and more.

### Core Concepts

- **Source**: A readable stream of messages with optional additional properties
- **Sink**: A writable stream for messages with optional additional properties
- **Transport**: A combination of Source and Sink that can both read and write messages
- **BinaryTransport**: A transport that works with raw binary messages instead of decoded Message objects

## Architecture

The transport system follows a composable architecture where:

1. **Base transports** handle the actual communication (HTTP, SSE, WebSocket, PubSub)
2. **Middleware transports** wrap other transports to add functionality (encryption, rate limiting, logging, validation)
3. **Utility functions** help compose, pipe, and transform transports

This design allows you to build complex transport stacks by combining simple, focused transports.

## Available Transports

### Communication Transports

#### HTTP (`http/`)

Handles message transmission over HTTP requests. Useful for environments where WebSockets or SSE aren't available.

- **`getHTTPSource`**: Creates a source that receives messages from HTTP POST requests
- **`getHTTPSink`**: Creates a sink that sends messages as HTTP POST requests with batching support

**Features:**

- Automatic message batching (configurable batch size and delay)
- Single-use source (closes after request completes)
- Binary message array encoding/decoding

#### SSE (`sse/`)

Server-Sent Events transport for one-way server-to-client communication.

- **`getSSESource`**: Creates a source from an EventSource that receives SSE messages
- **`getSSESink`**: Creates a sink that sends messages as SSE events with automatic ping/pong

**Features:**

- Automatic keepalive pings every 5 seconds
- Client ID handshake
- Base64-encoded binary messages

#### PubSub (`pubSub/`)

Generic publish/subscribe transport that works with any PubSub backend implementation.

- **`getPubSubSource`**: Subscribes to topics and receives messages
- **`getPubSubSink`**: Publishes messages to topics
- **`getPubSubTransport`**: Combines source and sink into a full transport

**Features:**

- Topic-based message routing
- Source ID filtering to prevent message loops
- Dynamic topic subscription/unsubscription

#### Redis (`redis/`)

Redis-backed PubSub transport implementation.

- **`RedisPubSub`**: Redis implementation of the PubSub interface
- **`getRedisTransport`**: Creates a Redis-based transport with connection management

**Features:**

- Separate publisher/subscriber connections
- Automatic connection cleanup
- Topic-based message distribution

#### NATS (`nats/`)

NATS messaging system PubSub implementation.

- **`NatsPubSub`**: NATS implementation of the PubSub interface

**Features:**

- Connection-based PubSub (no direct Redis dependency)
- Automatic connection draining on dispose

### Document Synchronization Transports

#### YDoc (`ydoc/`)

Integrates Y.js documents with the Teleportal transport system.

- **`getYDocSource`**: Creates a source that emits messages when Y.js document updates
- **`getYDocSink`**: Creates a sink that applies incoming messages to a Y.js document
- **`getYTransportFromYDoc`**: Creates a complete transport from a Y.js document

**Features:**

- Automatic Y.js update encoding/decoding
- Awareness (presence) synchronization
- Document sync protocol (sync-step-1, sync-step-2, sync-done)
- Transaction origin tracking to prevent update loops
- Support for milestone messages

#### Encrypted (`encrypted/`)

Wraps a transport with end-to-end encryption for document messages.

- **`getEncryptedTransport`**: Creates an encrypted transport using an EncryptionClient

**Features:**

- Encrypts document updates before transmission
- Decrypts incoming document updates
- Uses YDoc transport internally for document synchronization

### Middleware Transports

#### Passthrough (`passthrough/`)

A utility transport that wraps another transport and allows inspection/interception of messages.

- **`withPassthroughSource`**: Wraps a source with read callbacks
- **`withPassthroughSink`**: Wraps a sink with write callbacks
- **`withPassthrough`**: Wraps a full transport with both read and write callbacks
- **`noopTransport`**: Creates an empty transport that does nothing

**Use cases:**

- Debugging and logging
- Message filtering
- Metrics collection

#### Logger (`logger/`)

Convenience wrapper around passthrough that logs all messages to the console.

- **`withLogger`**: Wraps a transport and logs all read/write operations

#### Rate Limiter (`rate-limiter/`)

Implements rate limiting using a token bucket algorithm.

- **`withRateLimit`**: Wraps a transport with rate limiting
- **`RateLimitedTransport`**: The rate-limited transport class

**Features:**

- Configurable message rate (messages per time window)
- Maximum message size enforcement
- Token bucket algorithm for smooth rate limiting
- Per-user, per-document, or per-connection tracking
- Persistent rate limit storage (Redis, memory, etc.)
- Permission system integration
- Callbacks for rate limit exceeded events
- Metrics and events

#### Message Validator (`message-validator/`)

Adds authorization checks to message reading and writing.

- **`withMessageValidator`**: Wraps a transport with authorization checks
- **`withMessageValidatorSource`**: Validates messages on read
- **`withMessageValidatorSink`**: Validates messages on write

**Features:**

- Async authorization function support
- Separate read/write authorization
- Messages filtered out if not authorized

#### ACK (`ack/`)

Adds acknowledgment message support for reliable message delivery.

- **`withAckSink`**: Automatically sends ACK messages after writing
- **`withAckTrackingSink`**: Tracks sent messages and waits for ACKs

**Features:**

- Automatic ACK generation for non-ACK messages
- ACK timeout handling
- Promise-based ACK waiting
- PubSub-based ACK distribution

### File Transfer Transport

#### Send File (`send-file/`)

Adds file upload/download capabilities to any transport.

- **`withSendFile`**: Wraps a transport with file transfer methods

**Features:**

- Chunked file upload/download
- Merkle tree verification for integrity
- Optional encryption support
- File caching to avoid duplicate downloads
- Upload/download state tracking

**Methods added:**

- `upload(file, document, fileId?, encryptionKey?)`: Upload a file
- `download(fileId, document, encryptionKey?, timeout?)`: Download a file

## Utility Functions

The `utils.ts` module provides essential utilities for working with transports:

### Stream Composition

- **`compose(source, sink)`**: Combines a Source and Sink into a Transport
- **`pipe(source, sink)`**: Pipes messages from a Source to a Sink
- **`sync(transportA, transportB)`**: Bidirectionally syncs two transports

### Fan-Out/Fan-In

- **`createFanOutWriter()`**: Creates a writer that broadcasts to multiple readers
- **`createFanInReader()`**: Creates a reader that aggregates from multiple writers

**Use cases:**

- Broadcasting messages to multiple clients
- Aggregating messages from multiple sources

### Message Encoding/Decoding

- **`getMessageReader(context)`**: Creates a transform stream that decodes binary messages
- **`toBinaryTransport(transport, context)`**: Converts a Transport to a BinaryTransport
- **`fromBinaryTransport(transport, context)`**: Converts a BinaryTransport to a Transport

**Features:**

- Automatic ping/pong handling in binary transports
- Context injection into decoded messages

### Message Batching

- **`getBatchingTransform(options)`**: Batches multiple messages together
- **`toMessageArrayStream()`**: Converts individual messages to message arrays
- **`fromMessageArrayStream(context)`**: Converts message arrays back to individual messages

**Batching options:**

- `maxBatchSize`: Maximum messages per batch (default: 10)
- `maxBatchDelay`: Maximum delay before sending a batch (default: 100ms)

## Usage Examples

### Basic Transport Composition

```typescript
import { compose } from "teleportal/transports";
import { getHTTPSource, getHTTPSink } from "teleportal/transports/http";
import { withLogger } from "teleportal/transports/logger";
import { withRateLimit } from "teleportal/transports/rate-limiter";

// Create an HTTP transport
const source = getHTTPSource({ context });
const sink = getHTTPSink({ request, context });
const transport = compose(source, sink);

// Add logging
const loggedTransport = withLogger(transport);

// Add rate limiting
const rateLimitedTransport = withRateLimit(loggedTransport, {
  maxMessages: 100,
  windowMs: 1000,
});
```

### Y.js Document Transport

```typescript
import { getYTransportFromYDoc } from "teleportal/transports/ydoc";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";

const ydoc = new Y.Doc();
const awareness = new Awareness(ydoc);
const document = "my-document";

const transport = getYTransportFromYDoc({
  ydoc,
  awareness,
  document,
  context: { clientId: "client-1" },
});

// Start synchronization
await transport.handler.start();
```

### PubSub Transport with Redis

```typescript
import { getRedisTransport } from "teleportal/transports/redis";

const transport = getRedisTransport({
  getContext: { serverId: "server-1" },
  redisOptions: {
    path: "redis://localhost:6379",
  },
  sourceId: "server-1",
  topicResolver: (message) => `document/${message.document}`,
});

// Subscribe to a document topic
await transport.subscribe("document/my-doc");

// Clean up
await transport.close();
```

### Encrypted Transport

```typescript
import { getEncryptedTransport } from "teleportal/transports/encrypted";
import { EncryptionClient } from "teleportal/transports/encrypted/client";

const handler = new EncryptionClient({
  document: "my-doc",
  // ... encryption configuration
});

const transport = getEncryptedTransport(handler);

// Transport automatically encrypts/decrypts document messages
```

### File Transfer

```typescript
import { withSendFile } from "teleportal/transports/send-file";

const fileTransport = withSendFile({
  transport: baseTransport,
  context: { clientId: "client-1" },
});

// Upload a file
const fileId = await fileTransport.upload(
  file,
  "my-document",
  undefined, // auto-generate fileId
  encryptionKey, // optional
);

// Download a file
const downloadedFile = await fileTransport.download(
  fileId,
  "my-document",
  encryptionKey, // optional
);
```

### ACK-Based Reliable Delivery

```typescript
import { withAckSink, withAckTrackingSink } from "teleportal/transports/ack";

// Server: Send ACKs automatically
const ackSink = withAckSink(sink, {
  pubSub,
  ackTopic: "acks",
  sourceId: "server-1",
  context: serverContext,
});

// Client: Track ACKs
const trackingSink = withAckTrackingSink(sink, {
  pubSub,
  ackTopic: "acks",
  sourceId: "client-1",
  ackTimeout: 10000,
});

// Write messages and wait for ACKs
await trackingSink.writable.getWriter().write(message);
await trackingSink.waitForAcks();
```

## Transport Composition Patterns

### Layered Middleware

Transports can be composed in layers, with each layer adding functionality:

```typescript
// Base transport
let transport = getBaseTransport();

// Add encryption
transport = getEncryptedTransport(handler);

// Add rate limiting
transport = withRateLimit(transport, options);

// Add logging
transport = withLogger(transport);

// Add message validation
transport = withMessageValidator(transport, {
  isAuthorized: async (message, type) => {
    // Authorization logic
    return true;
  },
});
```

### Bidirectional Sync

Sync two transports to keep them in sync:

```typescript
import { sync } from "teleportal/transports";

const transportA = getTransportA();
const transportB = getTransportB();

// Messages from A go to B, and vice versa
await sync(transportA, transportB);
```

### Fan-Out Broadcasting

Broadcast messages to multiple clients:

```typescript
import { createFanOutWriter } from "teleportal/transports";

const { writable, getReader } = createFanOutWriter<Message>();

// Create multiple readers (one per client)
const client1Reader = getReader();
const client2Reader = getReader();
const client3Reader = getReader();

// Write once, all clients receive it
await writable.getWriter().write(message);
```

## Best Practices

1. **Compose from bottom up**: Start with base transports, then add middleware
2. **Handle errors**: Transports can error, ensure proper error handling
3. **Clean up resources**: Call `close()` or `unsubscribe()` when done
4. **Use appropriate transports**: Choose transports based on your use case (HTTP for simple, SSE for one-way, WebSocket for bidirectional)
5. **Rate limit client transports**: Always rate limit client-side transports to prevent abuse
6. **Validate messages**: Use message validators for authorization checks
7. **Monitor with logging**: Use logger transport during development

## Type Safety

All transports are fully typed with TypeScript:

- **Context types**: Extend `ClientContext` or `ServerContext` for type safety
- **Additional properties**: Transports can add additional properties to the transport object
- **Message types**: Messages are typed based on their context

## Testing

Each transport module includes test files demonstrating usage:

- `*.test.ts` files show how to use each transport
- Tests use the passthrough transport for inspection
- Mock transports can be created using `noopTransport()`

## See Also

- [Protocol Documentation](../lib/README.md) - Message format and protocol details
- [Providers Documentation](../providers/README.md) - High-level client API
- [Storage Documentation](../storage/README.md) - Persistence layer
