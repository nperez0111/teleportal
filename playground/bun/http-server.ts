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

const httpHandlers = getHandlers({
  server,
  validateRequest: async (request) => {
    return { userId: "123", room: "123" };
  },
});

const instance = Bun.serve({
  routes: {
    "/": homepage,
  },
  async fetch(request) {
    return httpHandlers(request);
  },
  idleTimeout: 255,
});

console.log(`Server running on http://${instance.hostname}:${instance.port}`);
