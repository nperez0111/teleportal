import { createStorage } from "unstorage";

import { Server } from "teleportal/server";
import {
  EncryptedDocumentStorage,
  UnstorageDocumentStorage,
} from "teleportal/storage";
import { getHandlers } from "teleportal/http";

import { logger } from "../src/backend/logger";
import homepage from "../src/index.html";

const memoryStorage = createStorage();

const server = new Server({
  getStorage: async (ctx) => {
    if (ctx.document.includes("encrypted")) {
      return new EncryptedDocumentStorage(memoryStorage);
    }
    return new UnstorageDocumentStorage(memoryStorage);
  },
  logger: logger,
});

const httpHandlers = getHandlers({ server });

const instance = Bun.serve({
  routes: {
    "/": homepage,
  },
  async fetch(request) {
    console.log("fetch", request.url);
    return httpHandlers(request);
  },
  idleTimeout: 255,
});

console.log(`Server running on http://${instance.hostname}:${instance.port}`);
