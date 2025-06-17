import crossws from "crossws/adapters/bun";
import { createDatabase } from "db0";
import bunSqlite from "db0/connectors/bun-sqlite";
import { createStorage } from "unstorage";
import dbDriver from "unstorage/drivers/db0";

import { Server } from "../src/server/server";
import { UnstorageDocumentStorage } from "../src/storage/unstorage";
import { createHandler } from "../src/websocket-server";
import homepage from "./index.html";

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

const ws = crossws({
  hooks: createHandler(
    new Server({
      getStorage: async (ctx) => {
        return new UnstorageDocumentStorage(storage, {
          scanKeys: false,
        });
      },
      checkPermission: async (context) => {
        return true;
      },
    }),
    {
      onUpgrade: async () => {
        return {
          context: {
            room: "test",
            userId: "test",
          },
        };
      },
    },
  ).hooks,
});

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
