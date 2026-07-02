/**
 * Real Bun WebSocket server for file upload benchmarks.
 * Mirrors playground/bun/server.ts exactly — same storage drivers,
 * rate limiting, logging, and middleware.
 *
 * Run from project root so playground workspace deps resolve.
 */
import crossws from "crossws/adapters/bun";
import { createStorage } from "unstorage";

import { getFileRpcHandlers } from "../../src/protocols/file";
import { Server } from "../../src/server";
import {
  UnstorageFileStorage,
  UnstorageTemporaryUploadStorage,
  UnstorageRateLimitStorage,
} from "../../src/storage";
import { MemoryDocumentStorage } from "../../src/storage/in-memory/document-storage";
import { createTokenManager, type TokenPayload } from "../../src/token";
import { defaultRateLimitRules } from "../../src/transports/rate-limiter";
import { tokenAuthenticatedWebsocketHandler } from "../../src/websocket-server";

// ---------- CLI flags ----------

const useUnstorage = process.argv.includes("--unstorage");
const useRateLimit = process.argv.includes("--rate-limit");

// ---------- Storage ----------

import { InMemoryFileStorage, InMemoryTemporaryUploadStorage } from "../../src/storage/in-memory";

const fileStorage = useUnstorage
  ? (() => {
      const memoryStorage = createStorage();
      const temporaryUploadStorage = new UnstorageTemporaryUploadStorage(memoryStorage, {
        keyPrefix: "file",
      });
      return new UnstorageFileStorage(memoryStorage, {
        keyPrefix: "file",
        temporaryUploadStorage,
      });
    })()
  : (() => {
      const temporaryUploadStorage = new InMemoryTemporaryUploadStorage();
      return new InMemoryFileStorage({ temporaryUploadStorage });
    })();

// ---------- Rate limiting ----------

const rateLimitStorage = new UnstorageRateLimitStorage(createStorage());
const rateLimitRules = defaultRateLimitRules<TokenPayload & { clientId: string }>();

// ---------- Auth (same as playground) ----------

const tokenManager = createTokenManager({
  secret: "your-secret-key-here",
  expiresIn: 3600,
  issuer: "my-collaborative-app",
});

// ---------- Server ----------

const fileHandlers = getFileRpcHandlers(fileStorage);

const server = new Server<TokenPayload & { clientId: string }>({
  storage: new MemoryDocumentStorage(false),
  rpcHandlers: { ...fileHandlers },
  checkPermission: async () => true,
  ...(useRateLimit && {
    rateLimitConfig: {
      rules: rateLimitRules,
      rateLimitStorage,
      maxMessageSize: 10 * 1024 * 1024,
      getUserId: (message: any) => message.context?.userId,
      getDocumentId: (message: any) => message.document,
    },
  }),
});

const ws = crossws({
  hooks: tokenAuthenticatedWebsocketHandler({ server, tokenManager }),
});

const port = Number(process.env.BENCH_PORT) || 9877;

Bun.serve({
  port,
  websocket: ws.websocket,
  async fetch(request, bunServer) {
    const url = new URL(request.url);

    if (url.pathname === "/api/token" && request.method === "POST") {
      const { userId, room } = (await request.json()) as { userId: string; room: string };
      const token = await tokenManager.createToken(userId, room, [
        { pattern: "*", permissions: ["admin"] },
      ]);
      return Response.json({ token });
    }

    if (request.headers.get("upgrade") === "websocket") {
      return ws.handleUpgrade(request, bunServer);
    }

    if (url.pathname === "/health") {
      return new Response("ok");
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(
  `[server] listening on port ${port} (${useUnstorage ? "unstorage" : "in-memory"}${useRateLimit ? " + rate-limit" : ""})`,
);
