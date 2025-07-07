# Redis Server Synchronization

This module provides Redis pub/sub based synchronization for Teleportal servers, allowing multiple server instances to stay in sync with each other.

## Overview

The Redis sync transport enables cross-instance server synchronization by:
- Publishing document updates to Redis when they occur on one server
- Subscribing to Redis channels to receive updates from other servers
- Forwarding updates to local clients when received from other servers

## Features

- **Optional**: Only used when Redis connection is provided
- **Compartmentalized**: Redis dependencies are dynamically imported, not bundled unless used
- **Abstracted**: Uses the existing `YTransport` interface and pubsub transport for flexibility
- **Fault-tolerant**: Falls back to noop transport if Redis connection fails

## Basic Usage

### With Redis Synchronization

```typescript
import { Server, createRedisServerSyncTransportFactoryFromConnectionString } from 'teleportal/server';

// Create Redis sync transport factory
const redisSyncTransportFactory = await createRedisServerSyncTransportFactoryFromConnectionString(
  'redis://localhost:6379',
  context, // Your server context
  logger,  // Your logger instance
  {
    keyPrefix: 'teleportal:sync:',
  }
);

// Create server with Redis sync
const server = new Server({
  getStorage: async (ctx) => {
    // Your storage implementation
    return yourStorage;
  },
  checkPermission: async (ctx) => {
    // Your permission logic
    return true;
  },
  syncTransportFactory: redisSyncTransportFactory, // Enable cross-instance sync
});
```

### Without Redis Synchronization

```typescript
import { Server } from 'teleportal/server';

// Create server without Redis sync (single instance)
const server = new Server({
  getStorage: async (ctx) => {
    // Your storage implementation
    return yourStorage;
  },
  checkPermission: async (ctx) => {
    // Your permission logic
    return true;
  },
  // No syncTransportFactory provided - single instance mode
});
```

## Advanced Configuration

### Custom Redis Options

```typescript
import { createRedisServerSyncTransportFactory } from 'teleportal/server';

const redisSyncTransportFactory = await createRedisServerSyncTransportFactory({
  connection: {
    host: 'localhost',
    port: 6379,
    password: 'your-password',
    db: 0,
  },
  keyPrefix: 'your-app:sync:',
  options: {
    retryDelayOnFailover: 100,
    enableOfflineQueue: false,
  },
}, context, logger);
```

### Custom Sync Transport

You can implement your own sync transport factory by implementing the `ServerSyncTransportFactory` interface:

```typescript
import { ServerSyncTransportFactory, YTransport } from 'teleportal/server';

class YourCustomSyncTransportFactory implements ServerSyncTransportFactory<Context> {
  async createTransport(documentId: string): Promise<YTransport<Context, any>> {
    // Your implementation - create a YTransport for the document
    return {
      readable: new ReadableStream(),
      writable: new WritableStream(),
    };
  }
  
  async close(): Promise<void> {
    // Your implementation - clean up all resources
  }
}
```

## How It Works

1. **Document Updates**: When a document receives an update on one server instance, it broadcasts the update to local clients AND writes it to the Redis YTransport
2. **Cross-Instance Sync**: Other server instances with YTransports for the same document receive the update via Redis pub/sub
3. **Local Forwarding**: Each server instance forwards the received update to its local clients
4. **Deduplication**: Updates are not re-broadcast to the originating client to avoid loops

## Redis Channel Structure

The Redis sync transport uses the following channel naming convention:
```
{keyPrefix}{documentId}
```

For example:
- `teleportal:sync:doc123` for document ID "doc123"
- `teleportal:sync:room1/doc456` for document "doc456" in room "room1"

## Performance Considerations

- Redis sync is only used when multiple server instances need to synchronize
- Messages are encoded/decoded using the same protocol as client-server communication
- Separate Redis connections are used for publishing and subscribing for optimal performance
- Failed Redis operations are logged but don't stop normal server operation

## Error Handling

- Redis connection failures fall back to noop transport
- Individual publish/subscribe errors are logged but don't crash the server
- Transport cleanup is handled automatically when documents are destroyed

## Dependencies

The Redis sync transport reuses the existing pubsub transport which has an optional dependency on `ioredis` that is dynamically imported only when needed. This means:
- If you don't use Redis sync, `ioredis` won't be included in your bundle
- If you use Redis sync, `ioredis` should be available as a dependency
- The implementation reuses the existing `src/transports/pubsub` transport for consistency