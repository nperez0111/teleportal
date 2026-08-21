import { createStorage } from "unstorage";

import { tokenAuthenticatedHTTPHandler } from "teleportal/http";
import { Server, checkPermissionWithTokenManager } from "teleportal/server";
import { UnstorageDocumentStorage } from "teleportal/storage";
import { createTokenManager } from "teleportal/token";
import { tokenAuthenticatedBunWebsocketHandler } from "teleportal/websocket-server/bun";
import { getBoopRpcHandlers } from "./src/boop-server";

export const manifest = {
  slug: "awareness",
  title: "Awareness & Presence",
  description: "Live cursors, user presence, and boop RPC",
  tags: ["awareness", "presence", "rpc", "cursors"],
};

export { default as html } from "./src/index.html";

const memoryStorage = createStorage();

export const tokenManager = createTokenManager({
  secret: "awareness-demo-secret",
  expiresIn: 3600,
  issuer: "awareness-demo",
});

const server = new Server({
  storage: async (ctx) =>
    new UnstorageDocumentStorage(memoryStorage, {
      keyPrefix: "document",
      encrypted: ctx.encrypted,
    }),
  rpcHandlers: {
    ...getBoopRpcHandlers(),
  },
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

const CORS_HEADERS: HeadersInit = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function withCors(response: Response): Response {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    response.headers.set(key, value);
  }
  return response;
}

export async function fetch(request: Request, bunServer: any) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.headers.get("upgrade") === "websocket") {
    return handler.upgrade(request, bunServer);
  }

  const url = new URL(request.url);

  if (url.pathname === "/api/token" && request.method === "POST") {
    const { userId } = (await request.json()) as { userId: string };
    const token = await tokenManager.createToken(userId, "awareness", [
      { pattern: "*", permissions: ["admin"] },
    ]);
    return withCors(Response.json({ token }));
  }

  const response = await httpHandler(request);
  return withCors(response);
}

export const websocket = handler.websocket;
