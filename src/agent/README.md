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

Throws `"Document is required"` if `message.document` is empty/falsy.

**Returns:** `Promise<{ ydoc, awareness, client, session, [Symbol.asyncDispose] }>`

## Architecture

```
Agent.createAgent()
    ├── getYTransportFromYDoc()  → Creates Y.js transport (ydoc + awareness)
    ├── server.createClient()    → Registers client + spawns its consume loop
    ├── server.getOrOpenSession()→ Gets/creates the document session
    ├── transport.handler.start()→ Emits the initial sync message
    └── await transport.synced   → Resolves once the doc is synced
```

## Lifecycle & cleanup

`createClient` has side effects: it registers the client with the server and
spawns a background loop that consumes the transport's message source. Anything
created before `synced` resolves therefore holds live resources.

- **Success:** the returned `Symbol.asyncDispose` tears down via
  `session.removeClient(client)` + `transport.ydoc.destroy()`.
- **Failure (any step after `createClient` throws):** `createAgent` cleans up
  before rethrowing — `server.disconnectClient(client)` (idempotent; removes the
  client from every session it joined and ends its consume loop) plus
  `transport.ydoc.destroy()`. Without this, a failed setup would leak the client
  loop and the Y.Doc. See the `index.test.ts` regression test
  "disconnects the client and destroys the ydoc when setup fails after the
  client is created".

## Key Concepts

- **Room-based multi-tenancy** - Documents can be namespaced by room for isolation
- **Async disposal** - Returns `Symbol.asyncDispose` for proper cleanup via `session.removeClient()` and `ydoc.destroy()`
- **Error-path teardown** - Partial setups are disposed on failure (see above)
- **Observable message passing** - Facilitates transport source/sink communication
- **Wide events** - Emits a structured `agent_create` wide event (with
  `outcome`, `duration_ms`, `client_id`) for observability on both success and
  error paths

## Files

- `index.ts` - Agent class
- `index.test.ts` - Test suite
