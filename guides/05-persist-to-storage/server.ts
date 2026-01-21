import { createStorage } from "unstorage";
import memoryDriver from "unstorage/drivers/memory";

import { Server } from "teleportal/server";
import { UnstorageDocumentStorage } from "teleportal/storage";

const server = new Server({
  // There are multiple storage backends available, and you can implement your own.
  storage: new UnstorageDocumentStorage(
    createStorage({
      // use any driver you like (e.g. sqlite, redis, sql, etc.)
      driver: memoryDriver(),
    }),
  ),
});
