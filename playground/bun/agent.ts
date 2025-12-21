import crossws from "crossws/adapters/bun";
import { createStorage } from "unstorage";
// @ts-expect-error - unstorage driver types can't be resolved via exports but work at runtime
import fsDriver from "unstorage/drivers/fs";

import { Server } from "teleportal/server";
import {
  UnstorageDocumentStorage,
  UnstorageEncryptedDocumentStorage,
  UnstorageFileStorage,
  UnstorageTemporaryUploadStorage,
} from "teleportal/storage";
import { createTokenManager, TokenPayload } from "teleportal/token";
import { tokenAuthenticatedWebsocketHandler } from "teleportal/websocket-server";

import homepage from "../src/index.html";
import { Agent } from "../../src/agent";

const memoryStorage = createStorage({
  driver: fsDriver({
    base: "./tmp",
  }),
});

const tokenManager = createTokenManager({
  secret: "your-secret-key-here", // In production, use a strong secret
  expiresIn: 3600, // 1 hour
  issuer: "my-collaborative-app",
});

const server = new Server<TokenPayload & { clientId: string }>({
  getStorage: async (ctx) => {
    const backingStorage = memoryStorage;

    const temporaryUploadStorage = new UnstorageTemporaryUploadStorage(
      backingStorage,
      { keyPrefix: "upload" },
    );

    const fileStorage = new UnstorageFileStorage(backingStorage, {
      keyPrefix: "file",
      temporaryUploadStorage,
    });

    if (ctx.documentId.includes("encrypted")) {
      return new UnstorageEncryptedDocumentStorage(backingStorage, {
        fileStorage,
      });
    }
    return new UnstorageDocumentStorage(backingStorage, {
      scanKeys: false,
      fileStorage,
    });
  },
});

const ws = crossws(
  tokenAuthenticatedWebsocketHandler({
    server,
    tokenManager,
  }),
);

const instance = Bun.serve({
  development: {
    // hmr: false,
  },
  routes: {
    "/": homepage,
  },
  websocket: ws.websocket,
  async fetch(request, server) {
    if (request.headers.get("upgrade") === "websocket") {
      return ws.handleUpgrade(request, server);
    }

    // Otherwise, just return a 404
    return new Response("Not Found", { status: 404 });
  },
});

console.info(`Server running on http://${instance.hostname}:${instance.port}`);

new Promise((r) => setTimeout(r, 100));
const serverAgent = new Agent(server);

serverAgent
  .createAgent({
    document: "ABC-123",
    context: { clientId: "ajfkldsjklfdbc", userId: "test", room: "room1" },
    encrypted: false,
  })
  .then((agent) => {
    agent.ydoc.getText("TEST").insert(0, "whoaaAoh");
    console.log(agent.ydoc.getText("TEST").toJSON());
    setTimeout(() => {
      agent[Symbol.asyncDispose]();
    });
  });
