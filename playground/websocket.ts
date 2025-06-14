import { serve } from "crossws/server";
import { createHandler } from "../src/transports/websocket";
import { Server } from "../src/server";
import { UnstorageDocumentStorage } from "../src/storage/unstorage";
import { createStorage } from "unstorage";
import dbDriver from "unstorage/drivers/db0";
import { createDatabase } from "db0";
import bunSqlite from "db0/connectors/bun-sqlite";

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

serve({
  websocket: createHandler(
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
  fetch: () => {
    console.log("fetch");
    return new Response("Hello, world!", {
      headers: { "Content-Type": "text/plain" },
    });
  },
});
