import crossws from "crossws/adapters/bun";
import { createDatabase } from "db0";
import bunSqlite from "db0/connectors/bun-sqlite";
import { createStorage } from "unstorage";
import dbDriver from "unstorage/drivers/db0";

import { Server } from "match-maker/server";
import { UnstorageDocumentStorage } from "match-maker/storage";
import { getWebsocketHandlers } from "match-maker/websocket-server";
import { createTokenManager, TokenPayload } from "match-maker/token";

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

const server = new Server<TokenPayload & { clientId: string }>({
  getStorage: async (ctx) => {
    return new UnstorageDocumentStorage(storage, {
      scanKeys: false,
    });
  },
  checkPermission: async ({ context, documentId, document, client }) => {
    console.log("checkPermission", context);
    console.log("documentId", documentId);
    return tokenManager.hasDocumentPermission(context, document, "read");
  },
});

const tokenManager = createTokenManager({
  secret: "your-secret-key-here", // In production, use a strong secret
  expiresIn: 3600, // 1 hour
  issuer: "my-collaborative-app",
});

const ws = crossws(
  getWebsocketHandlers({
    onUpgrade: async (request) => {
      const url = new URL(request.url);
      const token = url.searchParams.get("token");
      console.log("token", token);
      const result = await tokenManager.verifyToken(token!);

      if (!result.valid || !result.payload) {
        console.log("unauthorized", result);
        throw new Response("Unauthorized", { status: 401 });
      }

      const payload = result.payload;
      console.log("payload", payload);

      return {
        context: payload,
      };
    },
    onConnect: async (ctx) => {
      await server.createClient(ctx.transport, ctx.context, ctx.id);
    },
    onDisconnect: async (id) => {
      await server.disconnectClient(id);
    },
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
