import { createStorage } from "unstorage";

import { tokenAuthenticatedHTTPHandler } from "teleportal/http";
import { Server, checkPermissionWithTokenManager } from "teleportal/server";
import { UnstorageDocumentStorage } from "teleportal/storage";
import { createTokenManager } from "teleportal/token";
import { tokenAuthenticatedBunWebsocketHandler } from "teleportal/websocket-server/bun";

export const manifest = {
  slug: "prosemirror",
  title: "ProseMirror Editor",
  description: "Minimal collaborative text editor with ProseMirror and Yjs",
  tags: ["editor", "text", "vanilla", "minimal"],
};

export { default as html } from "./src/index.html";

const memoryStorage = createStorage();

const tokenManager = createTokenManager({
  secret: "your-secret-key-here",
  expiresIn: 3600,
  issuer: "prosemirror-example",
});

const server = new Server({
  storage: async () => new UnstorageDocumentStorage(memoryStorage, { keyPrefix: "document" }),
  checkPermission: checkPermissionWithTokenManager(tokenManager),
});

const handler = tokenAuthenticatedBunWebsocketHandler({
  server,
  tokenManager,
  appSlug: manifest.slug,
});

const httpHandler = tokenAuthenticatedHTTPHandler({
  server,
  tokenManager,
});

export async function fetch(request: Request, bunServer: any) {
  if (request.headers.get("upgrade") === "websocket") {
    return handler.upgrade(request, bunServer);
  }

  const url = new URL(request.url);
  if (url.pathname === "/api/token" && request.method === "POST") {
    const { userId, room = "docs" } = (await request.json()) as {
      userId: string;
      room?: string;
    };
    const token = await tokenManager.createToken(userId, room, [
      { pattern: "*", permissions: ["admin"] },
    ]);
    return Response.json({ token });
  }

  return httpHandler(request);
}

export const websocket = handler.websocket;
