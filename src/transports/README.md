# Transports

The `transports` module provides a composable transport layer system for Teleportal. Transports are the abstraction layer that handles how messages are sent and received between clients and servers, allowing Teleportal to work over various communication protocols and patterns.

## Overview

A **Transport** is a combination of a **Source** (for reading messages) and a **Sink** (for writing messages). The transport system is built on async iterables, making it composable and allowing multiple transports to be chained together to add functionality like encryption, rate limiting, logging, and more.

### Core Concepts

- **Source**: An async iterable of batched messages (`AsyncIterable<Message[]>`) with optional additional properties
- **Sink**: A write/close interface for messages with optional additional properties
- **Transport**: A combination of Source and Sink that can both read and write messages
- **BinaryTransport**: A transport that works with raw binary messages instead of decoded Message objects

## Architecture

The transport system follows a composable architecture where:

1. **Base transports** handle the actual communication (HTTP, SSE, PubSub)
2. **Middleware transports** wrap other transports to add functionality (encryption, rate limiting, logging, validation)
3. **Utility functions** help compose, pipe, and transform transports

This design allows you to build complex transport stacks by combining simple, focused transports.

## Available Transports

### Communication Transports

#### HTTP (`http/`)

Handles message transmission over HTTP requests. Useful for environments where WebSockets or SSE aren't available.

- **`getHTTPSource`**: Creates a single-use source that receives messages from an HTTP POST request body (decoded as a `MessageArray`)
- **`getHTTPSink`**: Creates a sink that batches outgoing messages and sends them as HTTP POST requests

**Features:**

- Configurable message batching (`maxBatchSize`, `maxBatchDelay`)
- Single-use source (closes after request completes)
- MessageArray encoding/decoding for efficient binary transport

#### SSE (`sse/`)

Server-Sent Events transport for one-way server-to-client communication.

- **`getSSESink`**: Creates a sink that sends messages as SSE events; returns an `sseResponse` for the HTTP handler
- **`getSSESource`**: Creates a source from an `EventSource` that receives SSE messages

**Features:**

- Automatic keepalive pings every 5 seconds
- Client ID handshake as the first SSE event
- Base64-encoded binary messages
- Periodic close-check interval on the source side

#### PubSub (`pubSub/`)

Generic publish/subscribe transport that works with any `PubSub` backend implementation.

- **`getPubSubSource`**: Subscribes to topics and receives messages
- **`getPubSubSink`**: Publishes messages to topics
- **`getPubSubTransport`**: Combines source and sink into a full transport

**Features:**

- Topic-based message routing
- Source ID filtering to prevent message loops
- Dynamic topic subscription/unsubscription

#### Redis (`redis/`)

Redis-backed PubSub transport implementation.

- **`RedisPubSub`**: Redis implementation of the `PubSub` interface using separate publisher/subscriber connections
- **`getRedisTransport`**: Creates a Redis-based transport with automatic connection cleanup
- **`RedisRateLimitStorage`**: Redis implementation of `RateLimitStorage` for distributed rate limiting with Lua-script-based distributed locks

**Features:**

- Separate publisher/subscriber connections
- Reference-counted topic subscriptions (multiple subscribers share one Redis subscription)
- Automatic connection cleanup via `Symbol.asyncDispose`
- Distributed lock-based transactions for rate limit state

#### NATS (`nats/`)

NATS messaging system PubSub implementation.

- **`NatsPubSub`**: NATS implementation of the `PubSub` interface

**Features:**

- Lazy connection via a factory callback (avoids bundling the NATS client)
- Automatic connection draining on dispose

### Document Synchronization Transports

#### YDoc (`ydoc/`)

Integrates Y.js documents with the Teleportal transport system.

- **`getYDocSource`**: Creates a source that emits messages when Y.js document updates
- **`getYDocSink`**: Creates a sink that applies incoming messages to a Y.js document
- **`getYTransportFromYDoc`**: Creates a complete transport from a Y.js document

**Features:**

- Content-encrypted envelope encoding (structure update + encrypted sidecars)
- Awareness (presence) synchronization
- Document sync protocol (sync-step-1, sync-step-2, sync-done)
- Transaction origin tracking to prevent update loops
- Configurable update batching (`updateBatchIntervalMs`): rapid Y.Doc updates are merged via `Y.mergeUpdatesV2` before forwarding, reducing message count at the cost of latency
- Clean shutdown: pending batched updates are flushed on `destroy`

#### Encrypted (`encrypted/`)

End-to-end content-level encryption for document messages. The server stores structure-only updates (which reveal document shape but not content) alongside encrypted sidecars (which contain the actual text/data). Only clients with the correct `CryptoKey` can restore the full document.

- **`getEncryptedTransport`**: Creates a transport wrapping an `EncryptionClient`
- **`EncryptionClient`**: Manages encryption/decryption, sync handshake, and incremental sidecar compaction

**Features:**

- Content-level encryption: strips text content from Y.js updates into encrypted sidecars, leaving structure-only updates for the server
- Sync handshake: `start()` sends sync-step-1, `handleSyncStep1()` responds with an encrypted sync-step-2
- Incremental updates: `onUpdate()` encrypts local edits, `handleUpdate()` decrypts peer edits
- Background sidecar compaction: after `COMPACTION_THRESHOLD` (default 25) sidecars accumulate, a background task merges them into one; the compaction piggybacks on the next outgoing message
- Awareness encryption: awareness updates are encrypted/decrypted transparently

### Middleware Transports

#### Passthrough (`passthrough/`)

A utility transport that wraps another transport and allows inspection/interception of messages.

- **`withPassthroughSink`**: Wraps a sink with write callbacks; returning `false` from `onWrite` blocks the message
- **`withPassthroughSource`**: Wraps a source with read callbacks; returning `false` from `onRead` filters the message
- **`withPassthrough`**: Wraps a full transport with both read and write callbacks
- **`noopTransport`**: Creates an empty transport that does nothing (useful for testing)

#### Logger (`logger/`)

Convenience wrapper around passthrough that logs all messages to the console.

- **`withLogger`**: Wraps a transport and logs all read/write operations

#### Rate Limiter (`rate-limiter/`)

Inbound-only rate limiting using the token bucket algorithm with flow-control-by-delay.

- **`withRateLimit`**: Wraps a transport with rate limiting
- **`RateLimitedTransport`**: The rate-limited transport class
- **`defaultRateLimitRules`**: Pre-configured rules with separate budgets for sync, awareness/presence, and file transfers

**Design decisions:**

- **Inbound only**: outbound (server-to-client) writes are passed through untouched. Dropping a server-originated doc update permanently diverges the receiving client because Y.js parks every causally-later update on the missing dependency.
- **Flow control by delay** (default): rate-limited inbound messages are HELD until the bucket refills (up to `maxDelayMs`, default 1s), slowing the sender to the allowed rate without losing messages. Only waits past the budget drop the message and nack the sender. Set `maxDelayMs: 0` for drop-only behavior.
- **Multi-rule enforcement with token refunds**: a message dropped by one rule hands back the tokens it consumed from rules it already passed, preventing retry amplification.
- **Separate budgets** (default rules): awareness/presence messages get their own budget so cursor chatter cannot drain the sync budget that doc updates need.

**Features:**

- Configurable message rate (messages per time window) via `rules` array
- Dynamic limits: `maxMessages` and `windowMs` can be functions of the message
- Maximum message size enforcement with nack response
- Per-user, per-document, per-user-document, or per-transport tracking
- Persistent rate limit storage (Redis, memory, etc.), with an automatic in-memory per-transport fallback when no storage is configured
- Permission system integration (`checkPermission`, `shouldSkipRateLimit`)
- Callbacks for rate limit exceeded, delayed, and message size exceeded events
- Metrics collector and event emitter integration

#### Message Validator (`message-validator/`)

Adds authorization checks to message reading and writing.

- **`withMessageValidator`**: Wraps a transport with authorization checks
- **`withMessageValidatorSource`**: Validates messages on read
- **`withMessageValidatorSink`**: Validates messages on write

When no `isAuthorized` function is provided, all messages pass through (no filtering).

#### ACK (`ack/`)

Adds acknowledgment message support for reliable message delivery.

- **`withAckSink`**: Automatically sends ACK messages after writing (via PubSub)
- **`withAckTrackingSink`**: Tracks sent messages and waits for ACKs with timeout

**Features:**

- Automatic ACK generation for non-ACK messages
- ACK timeout handling
- Promise-based ACK waiting via `waitForAcks()`
- PubSub-based ACK distribution
- Abort signal support
- Settled-promise cleanup to avoid memory leaks on long-lived connections

### File Transfer

File transfer functionality has been moved to the Provider level using RPC handlers. See the [File Protocol documentation](../protocols/file/README.md) for details.

## Utility Functions

The `utils.ts` module provides essential utilities for working with transports:

### Composition & Connection

- **`compose(source, sink)`**: Combines a Source and Sink into a Transport
- **`connect(source, sink)`**: Drains a Source into a Sink (consumes all messages)
- **`sync(transportA, transportB)`**: Bidirectionally connects two transports
- **`forEachMessage(source, fn)`**: Drains a batched source one item at a time

### Concurrency

- **`createFanOutWriter()`**: Creates a broadcaster with `send()`, `close()`, and `getReader()` methods for fan-out to multiple consumers
- **`createSerialQueue(process)`**: A serial async queue that processes items one at a time in enqueue order; each `enqueue()` resolves only after its item has been processed

### Message Encoding/Decoding

- **`decodeMessages(context)`**: Creates a transform that decodes binary messages into typed messages
- **`toBinaryTransport(transport, context)`**: Converts a Transport to a BinaryTransport
- **`fromBinaryTransport(transport, context)`**: Converts a BinaryTransport to a Transport (handles ping/pong inline)

### Message Transforms

Batch-preserving transforms that lift per-item logic into transforms over `AsyncIterable<T[]>`:

- **`mapMessages(fn)`**: Map each item to one output (or drop by returning null)
- **`filterMessages(predicate)`**: Keep only items passing a predicate
- **`flatMapMessages(fn)`**: Expand each item into zero or more outputs
- **`toMessageArrayTransform()`**: Converts messages to MessageArray encoding
- **`fromMessageArrayTransform(context)`**: Decodes MessageArrays back to messages

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
  rules: [{ id: "per-user", maxMessages: 100, windowMs: 1000, trackBy: "user" }],
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
  key: encryptionKey, // CryptoKey
});

const transport = getEncryptedTransport(handler);

// Transport automatically encrypts/decrypts document messages
// handler.start() initiates the sync handshake
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
await trackingSink.write(message);
await trackingSink.waitForAcks();
```

## Transport Composition Patterns

### Layered Middleware

Transports can be composed in layers, with each layer adding functionality:

```typescript
// Base transport
let transport = getBaseTransport();

// Add rate limiting (inbound only)
transport = withRateLimit(transport, {
  rules: defaultRateLimitRules(),
});

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

Bidirectionally connect two transports:

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

const fanOut = createFanOutWriter<Message>();

// Create multiple readers (one per client)
const client1Reader = fanOut.getReader();
const client2Reader = fanOut.getReader();

// Write once, all clients receive it
fanOut.send(message);
```

## See Also

- [Protocol Documentation](../lib/protocol/README.md) - Message format and protocol details
- [Providers Documentation](../providers/README.md) - High-level client API
- [Storage Documentation](../storage/README.md) - Persistence layer
