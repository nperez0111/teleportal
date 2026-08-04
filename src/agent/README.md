# Agent

Server-side agents that participate in a collaborative document from inside the
server process — reading, writing, observing, handling presence, and calling RPC
methods exactly as a browser client would, with no network hop.

## Overview

`createAgent(server, options)` returns a full [`Provider`](../providers/README.md)
— the very same class the browser client uses — wired to the server over an
in-process [`serverTransport`](../providers/transports/server.ts) instead of a
socket. Because it is a real `Provider`, an agent gets the entire client feature
set for free: Y.js sync, `awareness`/presence, typed outbound RPC (`agent.rpc.*`),
subdocuments, and the `loaded`/`synced` promises.

Messages flow through the server's real rate-limited, validated transport chain,
so an agent behaves exactly as it would over the wire. The `serverTransport`
stamps the agent's authenticated `ServerContext` onto every message it sends, so
an agent can never spoof its own identity.

## Usage

```typescript
import { createAgent } from "teleportal/agent";

const agent = await createAgent(server, {
  document: "my-document",
  context: { clientId: "agent-1", userId: "system", room: "room-1" },
  encryptionKey: false, // or a CryptoKey / KeyResolver for an E2EE document
});

await agent.synced;

const text = agent.doc.getText("content");
text.insert(0, "Hello, collaborative world!");

agent.destroy();
```

### Calling RPC methods

An agent can _call_ server RPC methods and await typed responses — a capability
the previous bare agent lacked. Pass an RPC extension map and use `agent.rpc.*`:

```typescript
const agent = await createAgent(server, {
  document: "my-document",
  context: { clientId: "agent-1", userId: "system", room: "room-1" },
  encryptionKey: false,
  rpc: createMyRpc(), // built with createClientExtension from teleportal/rpc
});

const result = await agent.rpc.my.method({ ... });
```

### Encrypted documents

For an end-to-end encrypted document, pass the document's `CryptoKey` (or a
`KeyResolver`). The agent reads and writes **plaintext** locally through
`agent.doc`, while the wire and storage stay encrypted — the key never leaves the
agent. To act on an unencrypted document, pass `false`. Omitting `encryptionKey`
throws; encryption is never silently skipped.

## API

### `createAgent(server, options): Promise<Provider>`

**Parameters:**

- `server` — the `Server<ServerContext>` to attach to.
- `options.document` — document id to open. Throws `"Document is required"` if empty/falsy.
- `options.context` — the authenticated `ServerContext` (`clientId`, `userId`, `room`).
- `options.encryptionKey` — `CryptoKey | false | KeyResolver` (required).
- `options.rpc` — optional typed RPC extension map, exposed as `agent.rpc.*`.

Offline (IndexedDB) persistence is always disabled: server processes have no
IndexedDB and the document is already durable in the server's storage.

**Returns:** `Promise<Provider>` — a fully-synced provider. Dispose it with
`provider.destroy()` (or `using` / `Symbol.dispose`).

## Architecture

```
createAgent(server, options)
    ├── serverTransport(server, { id, context })  → in-process ConnectionTransport
    │       └── server.createClient({ transport, id })  → registers client + consume loop
    ├── new DirectConnection({ transports: [serverTransport] })
    ├── await connection.connect()                → establishes the loopback link
    ├── Provider.create({ connection, document, encryptionKey, rpc })
    └── await provider.synced                     → resolves once the doc is synced
```

The heavy lifting lives in [`serverTransport`](../providers/transports/server.ts),
a reusable `ConnectionTransport` that bridges a `Provider` straight into
`server.createClient(...)`. It can also be used directly to wire two servers
together in-process, or to build a custom server-side `Provider`.

## Lifecycle & cleanup

- **Success:** call `agent.destroy()`. As a `Provider`, this closes the
  connection (which disconnects the client and ends its consume loop), destroys
  the `Y.Doc`, and best-effort unannounces presence.
- **Failure (any step during setup throws):** `createAgent` tears down the
  in-flight connection before rethrowing (`connection.destroy()`), so a failed
  setup never leaks the client's background consume loop. `serverTransport`
  additionally disconnects any client it registered if `connect()` fails. See the
  `index.test.ts` regression test _"tears down the agent's client when connection
  setup fails"_.

## Key concepts

- **Full Provider surface** — `doc`, `awareness`, `rpc`, presence, `loaded`/`synced`.
- **Outbound RPC** — agents can call server RPC methods and await typed responses.
- **Room-based multi-tenancy** — documents are namespaced by `room` for isolation.
- **Authenticated context** — the transport stamps the agent's identity onto every
  message; agents cannot spoof `userId`/`room`.
- **Encryption** — pass a `CryptoKey`/`KeyResolver` to read/write plaintext on an
  E2EE document; the key never leaves the agent.
- **Wide events** — emits a structured `agent_create` wide event (with `outcome`,
  `duration_ms`, `client_id`, `encrypted`) on both success and error paths.

## Files

- `index.ts` — `createAgent` factory
- `index.test.ts` — test suite
- [`../providers/transports/server.ts`](../providers/transports/server.ts) — `serverTransport`
