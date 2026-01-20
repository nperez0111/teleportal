import { createServer } from "node:http";
import crossws from "crossws/adapters/node";
import { createDatabase } from "db0";
import sqlite from "db0/connectors/node-sqlite";
import { createStorage } from "unstorage";
// @ts-ignore - unstorage driver types can't be resolved via exports but work at runtime
import dbDriver from "unstorage/drivers/db0";
import type { ServerContext } from "teleportal";
import { Server, checkPermissionWithTokenManager } from "teleportal/server";
import { UnstorageDocumentStorage } from "teleportal/storage";
import { tokenAuthenticatedWebsocketHandler } from "teleportal/websocket-server";
import { createTokenManager } from "teleportal/token";

const db = createDatabase(
  sqlite({
    name: "node-yjs.db",
  }),
);

const storage = createStorage({
  driver: dbDriver({
    database: db,
    tableName: "yjs",
  }),
});

const tokenManager = createTokenManager({
  secret: "your-secret-key-here", // In production, use a strong secret
  expiresIn: 3600, // 1 hour
  issuer: "my-collaborative-app",
});

const serverInstance = new Server({
  storage: async (ctx: {
    documentId: string;
    context: ServerContext;
    encrypted: boolean;
  }) => {
    return new UnstorageDocumentStorage(storage, {
      keyPrefix: "document",
      scanKeys: false,
    });
  },
  checkPermission: checkPermissionWithTokenManager(tokenManager) as any,
});

const ws = crossws({
  hooks: tokenAuthenticatedWebsocketHandler({
    server: serverInstance as any,
    tokenManager: tokenManager as any,
  }),
});

const server = createServer(async (req, res) => {
  res.end("");
});

server.on("upgrade", ws.handleUpgrade);

server.listen(process.env.PORT || 3000, () => {
  const addr = server.address() as { port: number };
  console.info(`Server running at http://localhost:${addr.port}`);
});
