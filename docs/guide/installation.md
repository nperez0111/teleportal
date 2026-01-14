# Installation

Install Teleportal using your preferred package manager.

## npm

```bash
npm install teleportal
```

## bun

```bash
bun add teleportal
```

## pnpm

```bash
pnpm add teleportal
```

## yarn

```bash
yarn add teleportal
```

## Requirements

- **Node.js >= 24** or any modern JavaScript runtime (Bun, Deno, etc.)
- TypeScript support is included (no additional types package needed)

## Package Exports

Teleportal provides multiple entry points for different use cases:

```typescript
// Core library
import { ... } from "teleportal"

// Server implementation
import { Server } from "teleportal/server"

// Client providers
import { Provider } from "teleportal/providers"

// Storage implementations
import { createInMemory, createUnstorage } from "teleportal/storage"

// HTTP handlers
import { getHttpHandlers } from "teleportal/http"

// WebSocket server handlers
import { getWebsocketHandlers } from "teleportal/websocket-server"

// Protocol encoding/decoding
import { encodeMessage, decodeMessage } from "teleportal/protocol"

// JWT token utilities
import { createTokenManager } from "teleportal/token"

// Monitoring and metrics
import { createMetrics } from "teleportal/monitoring"
```

See the [API Reference](../api/server.md) for a complete list of exports.

## Next Steps

- [Quick Start](./quick-start.md) - Get up and running quickly
- [Server Setup](./server-setup.md) - Learn how to set up the server
