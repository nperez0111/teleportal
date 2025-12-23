import crossws from "crossws/adapters/bun";
import { createStorage } from "unstorage";

import { getHTTPHandler } from "teleportal/http";
import { Server } from "teleportal/server";
import {
  UnstorageEncryptedDocumentStorage,
  UnstorageDocumentStorage,
  UnstorageFileStorage,
  UnstorageTemporaryUploadStorage,
} from "teleportal/storage";
import {
  checkPermissionWithTokenManager,
  createTokenManager,
} from "teleportal/token";
import { tokenAuthenticatedWebsocketHandler } from "teleportal/websocket-server";

import homepage from "../src/index.html";

const memoryStorage = createStorage();

const tokenManager = createTokenManager({
  secret: "your-secret-key-here", // In production, use a strong secret
  expiresIn: 3600, // 1 hour
  issuer: "my-collaborative-app",
});

const server = new Server({
  getStorage: async (ctx) => {
    const fileStorage = new UnstorageFileStorage(memoryStorage, {
      keyPrefix: "file",
    });
    fileStorage.temporaryUploadStorage = new UnstorageTemporaryUploadStorage(
      memoryStorage,
      { keyPrefix: "file" },
    );
    let documentStorage:
      | UnstorageDocumentStorage
      | UnstorageEncryptedDocumentStorage;
    if (ctx.documentId.includes("encrypted")) {
      documentStorage = new UnstorageEncryptedDocumentStorage(memoryStorage, {
        fileStorage,
      });
    } else {
      documentStorage = new UnstorageDocumentStorage(memoryStorage, {
        fileStorage,
      });
    }
    fileStorage.setDocumentStorage(documentStorage);
    return documentStorage;
  },

  checkPermission: checkPermissionWithTokenManager(tokenManager),
});

const ws = crossws(
  tokenAuthenticatedWebsocketHandler({
    server,
    tokenManager,
  }),
);

const httpHandlers = getHTTPHandler({
  server,
  getContext: async () => {
    return { userId: "123", room: "123" };
  },
});

const instance = Bun.serve({
  routes: {
    "/": homepage,
  },
  websocket: ws.websocket,
  async fetch(request, server) {
    if (request.headers.get("upgrade") === "websocket") {
      return ws.handleUpgrade(request, server);
    }

    return httpHandlers(request);
  },
});

console.info(`Server running on http://${instance.hostname}:${instance.port}`);
