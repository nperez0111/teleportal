# Teleportal Protocols

Built-in RPC protocol implementations for Teleportal's Y.js Sync Server.

## Packages

- [`teleportal/protocols/milestone`](./milestone/README.md) - Document versioning (milestone CRUD)
- [`teleportal/protocols/file`](./file/README.md) - Chunked file upload/download with Merkle proof verification
- [`teleportal/protocols/key-registry`](./key-registry/README.md) - Server-mediated encryption key distribution
- [`teleportal/protocols/attribution`](./attribution/README.md) - Attribution (authorship) read methods

Each protocol follows the same structure:

```
methods.ts   — method contracts (defineMethod/defineProtocol)
server.ts    — server handlers (createHandlers)
client.ts    — client extension (createClientExtension)
index.ts     — public exports
```

## Server

```typescript
import { Server } from "teleportal/server";
import { getMilestoneRpcHandlers } from "teleportal/protocols/milestone";
import { getFileRpcHandlers } from "teleportal/protocols/file";
import { getKeyRegistryRpcHandlers } from "teleportal/protocols/key-registry";

const server = new Server({
  storage: async () => documentStorage,
  rpcHandlers: {
    ...getMilestoneRpcHandlers(milestoneStorage),
    ...getFileRpcHandlers(fileStorage),
    ...getKeyRegistryRpcHandlers(keyRegistryStorage),
  },
});
```

## Client

Protocols are consumed via the Provider's `rpc` extension system:

```typescript
import { Provider } from "teleportal/providers";
import { createMilestoneRpc } from "teleportal/protocols/milestone";
import { createFileRpc } from "teleportal/protocols/file";
import { createKeyRegistryRpc } from "teleportal/protocols/key-registry";

const provider = await Provider.create({
  url: "wss://...",
  document: "my-doc",
  rpc: {
    milestones: createMilestoneRpc,
    file: () => createFileRpc({ encryptionKey }),
    keys: createKeyRegistryRpc,
  },
});

const milestones = await provider.rpc.milestones.list();
const fileId = await provider.rpc.file.upload(myFile);
const meta = await provider.rpc.keys.meta();
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
