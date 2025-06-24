import crossws from "crossws/adapters/bun";
import { createDatabase } from "db0";
import bunSqlite from "db0/connectors/bun-sqlite";
import { createStorage } from "unstorage";
import dbDriver from "unstorage/drivers/db0";

import { Server } from "teleportal/server";
import { UnstorageDocumentStorage } from "teleportal/storage";
import {
  checkPermissionWithTokenManager,
  createTokenManager,
  TokenPayload,
} from "teleportal/token";
import { tokenAuthenticatedWebsocketHandler } from "teleportal/websocket-server";

import homepage from "../frontend/index.html";

const db = createDatabase(
  bunSqlite({
    name: "yjs.db",
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

const server = new Server<TokenPayload & { clientId: string }>({
  getStorage: async (ctx) => {
    return new UnstorageDocumentStorage(storage, {
      scanKeys: false,
    });
  },
  checkPermission: checkPermissionWithTokenManager(tokenManager),
});

const ws = crossws(
  tokenAuthenticatedWebsocketHandler({
    server,
    tokenManager,
  }),
);

Bun.serve({
  routes: {
    "/": homepage,
  },
  websocket: ws.websocket,
  fetch(request, server) {
    if (request.headers.get("upgrade") === "websocket") {
      return ws.handleUpgrade(request, server);
    }

    return new Response("Not found", { status: 404 });
  },
});
