# Teleportal in 5 Minutes: A Local-First Y.js Sync Server

---

## 0. Audience + Goal

- Technical CRDT audience (FOSDEM local-first / CRDTs track)
- Fast mental model for Teleportal: what it is, why it exists, how it fits
- Focus: architecture, invariants, and deployment knobs

---

## 1. Why Teleportal?

- Y.js sync servers usually hard-code storage + transport + runtime
- Teleportal flips that: *protocol + composable building blocks*
- Goal: drop-in for production, minimal deps, scalable, local-first friendly

---

## 2. Design Principles (from the docs)

- **Storage agnostic**: interfaces for document/file/milestone storage
- **Transport agnostic**: WebSocket, HTTP, SSE, PubSub, custom
- **Runtime agnostic**: built on Web Streams + JS primitives
- **Zero in-memory docs on server**: scalable by default
- **Subdoc support**: full Y.js subdocument sync

---

## 3. Architecture at a Glance

```
Client Provider (Y.Doc)  <->  Connection  <->  Transport  <->  Server
        |                                           |
        |                                   Session + Storage
        +-- Awareness / Subdocs / Offline        +-- PubSub (multi-node)
```

- **Provider**: client-side Y.Doc + awareness + offline persistence
- **Server**: orchestrates sessions, routes messages, persists updates

---

## 4. Server Pipeline (Simplified)

```
Transport -> Message Validator -> Session -> Storage -> PubSub (optional)
```

- Sessions load from storage on-demand, clean up after idle timeout
- Permission checks happen per message (read/write)
- ACKs + message arrays enable efficient batching and reliability

---

## 5. Provider + Connection Model

- **Connection** handles network state, buffering, reconnection
- **Provider** handles Y.js sync, awareness, subdocs, milestones
- Fallback strategy: WebSocket first, HTTP/SSE fallback
- IndexedDB offline persistence supported out of the box

---

## 6. Quick Start (Core API)

```ts
import { Server } from "teleportal/server";
import { createInMemory } from "teleportal/storage";
import { getWebsocketHandlers } from "teleportal/websocket-server";

const server = new Server({
  getStorage: async () => {
    const { documentStorage } = createInMemory();
    return documentStorage;
  },
});

const handlers = getWebsocketHandlers({
  onConnect: async ({ transport, context, id }) => {
    await server.createClient(transport, context, id);
  },
});
```

---

## 7. Deployment Options (Local-First Friendly)

- **Single node**: in-memory or local KV for fast iteration
- **Multi-node**: Redis/NATS PubSub for fanout + storage for state
- **Storage**: Unstorage (Redis, Postgres, S3, R2, etc.) or custom
- **Observability**: Prometheus metrics + health/status endpoints

---

## 8. Takeaway

- Teleportal is a *framework* for CRDT sync servers, not a monolith
- Keep local-first UX (offline, subdocs) while scaling server-side
- Compose only what you need: storage, transport, auth, monitoring
