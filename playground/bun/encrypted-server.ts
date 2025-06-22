import crossws from "crossws/adapters/bun";
import { createDatabase } from "db0";
import bunSqlite from "db0/connectors/bun-sqlite";
import { createStorage } from "unstorage";
import dbDriver from "unstorage/drivers/db0";

import { Server } from "match-maker/server";
import { getWebsocketHandlers } from "match-maker/websocket-server";
import { EncryptedDocumentStorage } from "match-maker/storage";

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

const server = new Server({
  getStorage: async (ctx) => {
    return new EncryptedDocumentStorage(storage);
  },
  checkPermission: async (context) => {
    return true;
  },
});

const ws = crossws(
  getWebsocketHandlers({
    onUpgrade: async () => {
      return {
        context: {
          room: "test",
          userId: "test",
        },
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
