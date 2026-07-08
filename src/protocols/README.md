# Teleportal Protocols

Built-in RPC protocol implementations for Teleportal's Y.js Sync Server.

## Packages

- [`teleportal/protocols/milestone`](./milestone/README.md) - Document versioning (milestone CRUD)
- [`teleportal/protocols/file`](./file/README.md) - Chunked file upload/download with Merkle proof verification
- [`teleportal/protocols/key-registry`](./key-registry/README.md) - Server-mediated encryption key distribution
- [`teleportal/protocols/attribution`](./attribution/README.md) - Attribution (authorship) read methods

Each protocol follows the same core structure:

```
methods.ts   — method contracts (defineMethod/defineProtocol)
server.ts    — server handlers (createHandlers)
client.ts    — client extension (createClientExtension)
index.ts     — public exports
```

Some protocols add files for their specific concerns: `file/` has `transfer.ts` (the chunked
upload/download state machine) and `progress.ts`; `attribution/` has `resolve.ts` (client-side
range → attribution mapping); `key-registry/` has `storage.ts` (the `KeyRegistryStorage` interface)
and `http.ts` (mint/grant/revoke/rotate management endpoints).

## Server

Each protocol exposes a `get<Name>RpcHandlers(...)` factory that returns an `RpcHandlerRegistry`
(a map of wire-method name → handler). Spread them together into the `Server`'s `rpcHandlers`:

```typescript
import { Server } from "teleportal/server";
import { getMilestoneRpcHandlers } from "teleportal/protocols/milestone";
import { getFileRpcHandlers } from "teleportal/protocols/file";
import { getKeyRegistryRpcHandlers } from "teleportal/protocols/key-registry";
import { getAttributionRpcHandlers } from "teleportal/protocols/attribution";

const server = new Server({
  storage: async () => documentStorage,
  rpcHandlers: {
    ...getMilestoneRpcHandlers(milestoneStorage),
    ...getFileRpcHandlers(fileStorage),
    ...getKeyRegistryRpcHandlers(keyRegistryStorage),
    ...getAttributionRpcHandlers(), // reads via storage.retrieveAttribution()
  },
});
```

Some factories register server lifecycle hooks through `createHandlers`' `init` callback — e.g.
milestone triggers listen for `session-open`/`document-write`, and the file handler runs a periodic
expired-upload cleanup. These are torn down automatically when the server is disposed.

## Client

Protocols are consumed via the Provider's `rpc` extension system. Each extension is a
**per-provider** (per-document) factory, so a shared connection carrying messages for several open
documents never cross-contaminates their state:

```typescript
import { Provider } from "teleportal/providers";
import { createMilestoneRpc } from "teleportal/protocols/milestone";
import { createFileRpc } from "teleportal/protocols/file";
import { createKeyRegistryRpc } from "teleportal/protocols/key-registry";
import { createAttributionRpc } from "teleportal/protocols/attribution";

const provider = await Provider.create({
  url: "wss://...",
  document: "my-doc",
  encryptionKey,
  rpc: {
    milestones: createMilestoneRpc,
    file: () => createFileRpc({ encryptionKey }),
    keys: createKeyRegistryRpc,
    attribution: createAttributionRpc,
  },
});

const milestones = await provider.rpc.milestones.list();
const fileId = await provider.rpc.file.upload(myFile);
const meta = await provider.rpc.keys.meta();
const activity = await provider.rpc.attribution.getActivity();
```

## Adding a New Protocol

See [`teleportal/rpc`](../lib/rpc/README.md) for the full guide. In short:

1. Define the contract in `methods.ts` with `defineMethod` / `defineProtocol`
2. Implement server handlers in `server.ts` with `createHandlers`
3. Create a client extension in `client.ts` with `createClientExtension`
4. Re-export from `index.ts`

## See Also

- [`teleportal/rpc`](../lib/rpc/README.md) - RPC framework (defineMethod, createHandlers, createClientExtension)
- [`teleportal/protocol`](../lib/protocol/README.md) - Wire protocol encoding/decoding
