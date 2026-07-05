# Agent

Server-side agent for creating and managing collaborative document sessions with Y.js synchronization.

## Overview

The `Agent` class is a factory for creating collaborative document sessions in Teleportal. It bridges local Y.js documents with server-side synchronization, handling the setup of establishing connections, managing sessions, and cleaning up resources.

## Usage

```typescript
import { Agent } from "teleportal/agent";
import { Server } from "teleportal/server";

const agent = new Agent(server);

const result = await agent.createAgent({
  document: "my-document",
  context: { clientId: "client-1", userId: "user-1", room: "room-1" },
  encrypted: false,
});

const text = result.ydoc.getText("content");
text.insert(0, "Hello, collaborative world!");

await result[Symbol.asyncDispose]();
```

## API

### `createAgent(message, handler?)`

Creates a collaborative document session.

**Parameters:**

- `message.document` - Document ID to connect to
- `message.context` - Contains `clientId`, `userId`, and `room`
- `message.encrypted` - Whether the document is encrypted
- `handler` - Optional custom transport handlers (`YDocSinkHandler & YDocSourceHandler`)

**Returns:** `Promise<{ ydoc, awareness, client, session, [Symbol.asyncDispose] }>`

## Architecture

```
Agent.createAgent()
    ├── getYTransportFromYDoc()  → Creates Y.js transport
    ├── server.createClient()    → Registers client with server
    └── server.getOrOpenSession()→ Gets/creates document session
```

## Key Concepts

- **Room-based multi-tenancy** - Documents can be namespaced by room for isolation
- **Async disposal** - Returns `Symbol.asyncDispose` for proper cleanup via `session.removeClient()` and `ydoc.destroy()`
- **Observable message passing** - Facilitates transport source/sink communication
- **Wide events** - Emits structured `agent_create` events for observability

## Files

- `index.ts` - Agent class
- `index.test.ts` - Test suite
