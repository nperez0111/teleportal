import crossws from "crossws/adapters/bun";
import { createStorage } from "unstorage";
// @ts-ignore - unstorage driver types can't be resolved via exports but work at runtime
import fsDriver from "unstorage/drivers/fs";

import { Server } from "teleportal/server";
import { UnstorageDocumentStorage } from "teleportal/storage";
import { createTokenManager, TokenPayload } from "teleportal/token";
import { tokenAuthenticatedWebsocketHandler } from "teleportal/websocket-server";

import homepage from "../src/index.html";
import { createAgent } from "../../src/agent";

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
  storage: async (ctx) => {
    return new UnstorageDocumentStorage(memoryStorage, {
      keyPrefix: "document",
      encrypted: ctx.documentId.includes("encrypted"),
    });
  },
});

const ws = crossws({
  hooks: tokenAuthenticatedWebsocketHandler({
    server,
    tokenManager,
  }),
});

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

createAgent(server, {
  document: "ABC-123",
  context: { clientId: "ajfkldsjklfdbc", userId: "test", room: "room1" },
  encryptionKey: false,
}).then((agent) => {
  agent.doc.getText("TEST").insert(0, "whoaaAoh");
  console.log(agent.doc.getText("TEST").toJSON());
  setTimeout(() => {
    agent.destroy();
  });
});
