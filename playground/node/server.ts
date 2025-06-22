import { createServer } from "node:http";
import crossws from "crossws/adapters/node";
import { createDatabase } from "db0";
import sqlite from "db0/connectors/node-sqlite";
import { createStorage } from "unstorage";
import dbDriver from "unstorage/drivers/db0";

// Use the dist build, since node doesn't resolve the source very well
import { Server } from "../../dist/server/index.mjs";
import { UnstorageDocumentStorage } from "../../dist/storage/index.mjs";
import { getWebsocketHandlers } from "../../dist/websocket-server/index.mjs";

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

const serverInstance = new Server({
  getStorage: async (ctx) => {
    return new UnstorageDocumentStorage(storage, {
      scanKeys: false,
    });
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
      await serverInstance.createClient(ctx.transport, ctx.context, ctx.id);
    },
    onDisconnect: async (id) => {
      await serverInstance.disconnectClient(id);
    },
  }),
);

const server = createServer(async (req, res) => {
  res.end("");
});

server.on("upgrade", ws.handleUpgrade);

server.listen(process.env.PORT || 3000, () => {
  const addr = server.address() as { port: number };
  console.log(`Server running at http://localhost:${addr.port}`);
});
