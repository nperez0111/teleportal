# Key Registry Protocol

Server-mediated encryption key distribution for multi-user documents.

## Overview

The Key Registry stores wrapped (encrypted) document keys on the server so that authorized users can retrieve them without ever exposing the plaintext key to the server. Each user's copy of the document key is wrapped with a per-user wrapping key derived via HKDF, so a database breach reveals only opaque blobs.

This protocol provides:

- **RPC methods** for clients to fetch their wrapped key on connect
- **HTTP handlers** for the app server to mint, grant, revoke, and rotate keys
- **Key wrapping utilities** (HKDF-SHA256 + AES-KW) — all Web Crypto, no dependencies
- **`registryKey()` resolver** that plugs into `Provider.create`'s `encryptionKey` option

## Threat Model

**Server-breach protection with a trusted operator.** The server operator is trusted to issue tokens and manage access correctly, but if server storage is compromised, document content cannot be read — the server never holds plaintext document keys. Wrapping keys exist only in the running process memory and in transit to clients (over TLS).

## How It Works

```
App Server                    Teleportal Server              Client
    │                              │                           │
    │  POST /keys/:docId/mint      │                           │
    │  { userId, room }            │                           │
    │─────────────────────────────>│                           │
    │  { wrappingKey, generation } │                           │
    │<─────────────────────────────│                           │
    │                              │                           │
    │  (embed wrappingKey in JWT)  │                           │
    │─────────────────────────────────────────────────────────>│
    │                              │                           │
    │                              │  keysGet RPC              │
    │                              │<──────────────────────────│
    │                              │  { wrappedKey, gen }      │
    │                              │──────────────────────────>│
    │                              │                           │
    │                              │             unwrap locally │
    │                              │             with wrappingKey
    │                              │                    ↓      │
    │                              │           CryptoKey ready │
    │                              │           start syncing    │
```

1. **App server** calls `POST /keys/:docId/mint` — Teleportal generates a document key, wraps it for the user via HKDF + AES-KW, stores the wrapped blob, and returns the user's wrapping key.
2. **App server** embeds the wrapping key in the user's JWT token (or delivers it via any secure channel).
3. **Client** connects with `registryKey({ wrappingKey })` — the resolver automatically sends a `keysGet` RPC, unwraps the blob locally, and passes the plaintext `CryptoKey` to the Provider.

## Three Tiers of Key Distribution

All three tiers use the same `encryptionKey` option on `Provider.create`. Pick the one that matches your needs:

| Tier           | Mechanism                                     | Per-User Revocation | Server Involvement | When to Use                         |
| -------------- | --------------------------------------------- | ------------------- | ------------------ | ----------------------------------- |
| **Direct key** | `encryptionKey: key` or URL fragment          | No                  | None               | Quick sharing, demos                |
| **Password**   | `encryptionKey: passwordKey("...")`           | No                  | None               | Shared workspaces, simple apps      |
| **Registry**   | `encryptionKey: registryKey({ wrappingKey })` | Yes                 | Full               | Multi-user apps with access control |

## Server Setup

```typescript
import { Server } from "teleportal/server";
import {
  getKeyRegistryRpcHandlers,
  getKeyRegistryHandlers,
} from "teleportal/protocols/key-registry";
import { InMemoryKeyRegistryStorage } from "teleportal/storage/in-memory";

const keyRegistryStorage = new InMemoryKeyRegistryStorage();
const MASTER_SECRET = new TextEncoder().encode(process.env.MASTER_SECRET!);

const server = new Server({
  storage: ...,
  rpcHandlers: {
    ...getKeyRegistryRpcHandlers(keyRegistryStorage),
  },
});

// HTTP handlers for key management — called by the app server, not clients
const keyHandlers = getKeyRegistryHandlers({
  storage: keyRegistryStorage,
  masterSecret: MASTER_SECRET,
});

// Mount via the httpHandler's fetch fallback (or any HTTP router)
const httpHandler = tokenAuthenticatedHTTPHandler({
  server,
  tokenManager,
  fetch: (req) => {
    if (new URL(req.url).pathname.startsWith("/keys/")) {
      return keyHandlers(req);
    }
    return new Response("Not Found", { status: 404 });
  },
});
```

## Client Setup

```typescript
import { Provider } from "teleportal/providers";
import { registryKey, importWrappingKey } from "teleportal/encryption-key";
import { createKeyRegistryRpc } from "teleportal/protocols/key-registry";

// wrappingKey comes from the JWT token issued by the app server
const wrappingKey = await importWrappingKey(tokenPayload.wrappingKey);

const provider = await Provider.create({
  url: "wss://collab.myapp.com",
  document: "my-doc",
  token,
  encryptionKey: registryKey({ wrappingKey }),
  rpc: { keys: createKeyRegistryRpc },
});
```

## App Server Integration

The app server calls the HTTP handlers to manage keys. It never needs to import crypto utilities directly.

### Creating a Document

```typescript
// POST /api/documents — your app's "create document" endpoint
app.post("/api/documents", async (req) => {
  const { userId } = req.auth;
  const documentId = generateId();

  // Mint a document key — Teleportal handles all the crypto
  const { wrappingKey } = await fetch(`${TELEPORTAL_URL}/keys/${documentId}/mint`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, room: "default" }),
  }).then((r) => r.json());

  // Issue a JWT with the wrapping key
  const token = await tokenManager.createToken(userId, "default", [
    { pattern: documentId, permissions: ["admin", "write", "read"] },
  ]);

  return { documentId, token, wrappingKey };
});
```

### Sharing with Another User

```typescript
// POST /api/documents/:id/share
app.post("/api/documents/:id/share", async (req) => {
  const { documentId } = req.params;
  const { targetUserId, role } = req.body;

  // Grant access — wraps the existing document key for the new user
  const { wrappingKey } = await fetch(`${TELEPORTAL_URL}/keys/${documentId}/grant`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: targetUserId, room: "default" }),
  }).then((r) => r.json());

  const permissions =
    role === "read" ? ["read"] : role === "comment" ? ["read", "comment"] : ["read", "write"];

  const token = await tokenManager.createToken(targetUserId, "default", [
    { pattern: documentId, permissions },
  ]);

  return { token, wrappingKey };
});
```

### Batch Granting (Teams)

```typescript
const { wrappingKeys } = await fetch(`${TELEPORTAL_URL}/keys/${documentId}/grant`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ userIds: ["alice", "bob", "charlie"], room: "default" }),
}).then((r) => r.json());
// wrappingKeys: { "alice": "abc...", "bob": "def...", "charlie": "ghi..." }
```

### Revoking Access + Rotating the Key

```typescript
// Remove the user's wrapped key
await fetch(`${TELEPORTAL_URL}/keys/${documentId}/revoke`, {
  method: "DELETE",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ userIds: ["eve"], room: "default" }),
});

// Rotate — generates a new document key, re-wraps for remaining users
await fetch(`${TELEPORTAL_URL}/keys/${documentId}/rotate`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ excludeUserIds: ["eve"], room: "default" }),
});
// Connected clients are notified via keysRotated RPC and re-fetch automatically
```

## HTTP Endpoints

| Method   | Path                  | Body                         | Response                      | Purpose                                    |
| -------- | --------------------- | ---------------------------- | ----------------------------- | ------------------------------------------ |
| `POST`   | `/keys/:docId/mint`   | `{ userId, room? }`          | `{ generation, wrappingKey }` | Generate document key, wrap for first user |
| `POST`   | `/keys/:docId/grant`  | `{ userId, room? }`          | `{ wrappingKey }`             | Wrap existing key for a new user           |
| `POST`   | `/keys/:docId/grant`  | `{ userIds, room? }`         | `{ wrappingKeys }`            | Batch grant for multiple users             |
| `DELETE` | `/keys/:docId/revoke` | `{ userIds, room? }`         | `{ generation }`              | Remove users' wrapped keys                 |
| `POST`   | `/keys/:docId/rotate` | `{ excludeUserIds?, room? }` | `{ generation }`              | New key, re-wrap for remaining users       |
| `GET`    | `/keys/:docId/meta`   | —                            | `{ generation, userIds }`     | Current generation + who has access        |

The optional `room` field constructs a composite document ID (`room/docId`) to match the server's namespaced sessions.

## RPC Methods

These are used internally by `registryKey()` and the `createKeyRegistryRpc` client extension. You don't normally call them directly.

| Wire Name    | Request                               | Response                     | Purpose                          |
| ------------ | ------------------------------------- | ---------------------------- | -------------------------------- |
| `keysGet`    | `{}`                                  | `{ wrappedKey, generation }` | Fetch calling user's wrapped key |
| `keysSet`    | `{ entries: [{userId, wrappedKey}] }` | `{ generation }`             | Upsert wrapped keys              |
| `keysRevoke` | `{ userIds }`                         | `{ generation }`             | Remove wrapped keys              |
| `keysMeta`   | `{}`                                  | `{ generation, userIds }`    | Generation + access list         |
| `keysRotate` | `{ entries, expectedGeneration }`     | `{ generation }`             | Atomic replace + bump generation |

## Key Rotation

Key rotation uses optimistic concurrency via a monotonic generation counter — no lock flags or timeouts.

1. Caller reads `keysMeta` to get the current `generation` and user list.
2. Caller generates a new document key and wraps it for all remaining users.
3. Caller calls `keysRotate` with `expectedGeneration` matching the current generation.
4. Server validates the generation, atomically replaces all wrapped keys, bumps the generation.
5. If the generation doesn't match (concurrent rotation), the server rejects with a conflict error. The caller retries.
6. Server broadcasts a `keysRotated` notification to connected clients.
7. Clients invalidate their cached key and re-fetch on the next operation.

Old-generation keys are retained in storage so historical encrypted sidecars remain decryptable.

## Key Wrapping Utilities

These are in `teleportal/encryption-key` and used internally by the HTTP handlers. Available if you need lower-level control:

| Function                                     | Description                                         |
| -------------------------------------------- | --------------------------------------------------- |
| `deriveWrappingKey(masterSecret, userId)`    | HKDF-SHA256 → AES-KW key, domain-separated per user |
| `wrapDocumentKey(wrappingKey, documentKey)`  | AES-KW wrap → `Uint8Array` blob                     |
| `unwrapDocumentKey(wrappingKey, wrappedKey)` | AES-KW unwrap → `CryptoKey`                         |
| `exportWrappingKey(key)`                     | Export to JWK string (for JWT claims)               |
| `importWrappingKey(keyString)`               | Import from JWK string                              |

## File Structure

```
src/protocols/key-registry/
  methods.ts   — RPC method contracts (defineMethod/defineProtocol)
  server.ts    — server RPC handlers (createHandlers)
  client.ts    — client RPC extension (createClientExtension) + rotation notification
  http.ts      — HTTP handlers for mint/grant/revoke/rotate/meta
  storage.ts   — KeyRegistryStorage interface
  index.ts     — public exports

src/encryption-key/
  key-wrapping.ts  — HKDF + AES-KW utilities
  key-resolver.ts  — KeyResolver type, registryKey(), passwordKey()

src/storage/in-memory/
  key-registry-storage.ts  — InMemoryKeyRegistryStorage
```

## Design Decisions

**One key per document, roles enforced by the server.** All authorized users share the same AES-256-GCM document key. Access control (read/write/comment) is enforced by the server's `checkPermission`, not by encryption. The threat model is storage breach — if the server process is compromised, per-role keys wouldn't help since the server can relay anything.

**App server manages keys, not the client.** The app server owns the master secret and orchestrates key creation, wrapping, and distribution. Clients just unwrap their copy. This matches the typical centralized architecture where the app server already manages users, permissions, and tokens.

**HKDF + AES-KW symmetric wrapping.** Per-user wrapping keys are derived from a master secret + userId via HKDF-SHA256 with domain-separated info strings. Document keys are wrapped with AES-KW (RFC 3394). All Web Crypto API — no additional dependencies.

## See Also

- [`teleportal/encryption-key`](../../encryption-key/README.md) — Core encryption utilities
- [Milestone Protocol](../milestone/README.md) — Document versioning RPC
- [`teleportal/rpc`](../../lib/rpc/) — RPC framework primitives
