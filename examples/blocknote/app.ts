import { createDatabase } from "db0";
import bunSqlite from "db0/connectors/bun-sqlite";
import { createStorage } from "unstorage";
// @ts-ignore - unstorage driver types can't be resolved via exports but work at runtime
import dbDriver from "unstorage/drivers/db0";

import { importEncryptionKey } from "teleportal/encryption-key";
import { tokenAuthenticatedHTTPHandler } from "teleportal/http";
import { RpcMessage } from "teleportal/protocol";
import { getAttributionRpcHandlers } from "teleportal/protocols/attribution";
import { getFileRpcHandlers } from "teleportal/protocols/file";
import {
  getKeyRegistryRpcHandlers,
  getKeyRegistryHandlers,
} from "teleportal/protocols/key-registry";
import { getMilestoneRpcHandlers } from "teleportal/protocols/milestone";
import { Server, checkPermissionWithTokenManager } from "teleportal/server";
import {
  createEncryptedDriver,
  UnstorageDocumentStorage,
  UnstorageFileStorage,
  UnstorageMilestoneStorage,
  UnstorageRateLimitStorage,
  UnstorageTemporaryUploadStorage,
  UnstorageKeyRegistryStorage,
} from "teleportal/storage";
import { createTokenManager, type TokenPayload } from "teleportal/token";
import { defaultRateLimitRules } from "teleportal/transports/rate-limiter";
import { tokenAuthenticatedBunWebsocketHandler } from "teleportal/websocket-server/bun";

import "./src/backend/logger";

export const manifest = {
  slug: "blocknote",
  title: "BlockNote Editor",
  description: "Collaborative rich-text editor with encryption, milestones, files, and attribution",
  tags: ["editor", "rich-text", "react", "encryption", "sqlite"],
};

export { default as html } from "./src/index.html";

// Build the SharedWorker script at startup — use /tmp in containers where the
// source directory is read-only (USER bun).
const workerOutDir =
  Bun.env.NODE_ENV === "production" ? "/tmp/worker-dist" : import.meta.dir + "/.worker-dist";
const workerSrc = import.meta.dir + "/src/worker.ts";
const workerBanner =
  'if(typeof globalThis.window==="undefined")globalThis.window=globalThis;' +
  'if(typeof globalThis.document==="undefined")globalThis.document={};';
await Bun.spawn(
  [
    "bun",
    "build",
    workerSrc,
    "--outdir",
    workerOutDir,
    "--target",
    "browser",
    "--format",
    "esm",
    `--banner=${workerBanner}`,
  ],
  { stdout: "inherit", stderr: "inherit" },
).exited;

const db = createDatabase(
  bunSqlite({
    name: "yjs.db",
  }),
);

const storage = createStorage({
  driver: createEncryptedDriver(
    dbDriver({
      database: db,
      tableName: "yjs",
    }),
    importEncryptionKey("s1RZEGnuBelCbov-WC6dvddacpT1pzGmhmeVHKr-1Zg"),
  ),
});

const memoryStorage = createStorage();
const backingStorage = Bun.env.NODE_ENV === "production" ? memoryStorage : storage;

const temporaryUploadStorage = new UnstorageTemporaryUploadStorage(memoryStorage, {
  keyPrefix: "file",
});

const fileStorage = new UnstorageFileStorage(backingStorage, {
  keyPrefix: "file",
  temporaryUploadStorage,
});

const milestoneStorage = new UnstorageMilestoneStorage(backingStorage, {
  keyPrefix: "document-milestone",
});

const milestoneHandlers = getMilestoneRpcHandlers(milestoneStorage);
const fileHandlers = getFileRpcHandlers(fileStorage);

const rateLimitStorage = new UnstorageRateLimitStorage(memoryStorage);

const keyRegistryStorage = new UnstorageKeyRegistryStorage(backingStorage, {
  keyPrefix: "key-registry",
});
const MASTER_SECRET = new TextEncoder().encode("playground-master-secret-change-in-production");

const tokenManager = createTokenManager({
  secret: "your-secret-key-here",
  expiresIn: 3600,
  issuer: "my-collaborative-app",
});

const rateLimitRules = defaultRateLimitRules<TokenPayload & { clientId: string }>();

const server = new Server<TokenPayload & { clientId: string }>({
  storage: async (ctx) => {
    return new UnstorageDocumentStorage(backingStorage, {
      keyPrefix: "document",
      encrypted: ctx.encrypted,
    });
  },
  rpcHandlers: {
    ...milestoneHandlers,
    ...fileHandlers,
    ...getAttributionRpcHandlers(),
    ...getKeyRegistryRpcHandlers(keyRegistryStorage),
  },
  checkPermission: checkPermissionWithTokenManager(tokenManager),
  rateLimitConfig: {
    rules: rateLimitRules,
    rateLimitStorage,
    maxMessageSize: 10 * 1024 * 1024,
    getUserId: (message) => message.context?.userId,
    getDocumentId: (message) => message.document,
  },
});

const handler = tokenAuthenticatedBunWebsocketHandler({
  server,
  tokenManager,
  appSlug: manifest.slug,
});

const keyHandlers = getKeyRegistryHandlers({
  storage: keyRegistryStorage,
  masterSecret: MASTER_SECRET,
  onRotate: (documentId, generation) => {
    server
      .getSession(documentId)
      ?.broadcast(
        new RpcMessage(
          documentId,
          { type: "success", payload: { generation } },
          "keysRotated",
          "request",
          undefined,
          {},
          false,
        ) as any,
      );
  },
});

const httpHandler = tokenAuthenticatedHTTPHandler({
  server,
  tokenManager,
  fetch: (req) => {
    if (new URL(req.url).pathname.startsWith("/keys/")) {
      return keyHandlers(req);
    }
    return new Response("Not Found", { status: 404 });
  },
});

export async function fetch(request: Request, bunServer: any) {
  if (request.headers.get("upgrade") === "websocket") {
    return handler.upgrade(request, bunServer);
  }

  const url = new URL(request.url);
  const pathname = url.pathname;
  const distDir = import.meta.dir + "/dist";

  if (pathname === "/worker.js") {
    return new Response(Bun.file(workerOutDir + "/worker.js"), {
      headers: { "Content-Type": "application/javascript" },
    });
  }

  if (pathname === "/api/token" && request.method === "POST") {
    const { userId, room = "docs" } = (await request.json()) as {
      userId: string;
      room?: string;
    };
    const token = await tokenManager.createToken(userId, room, [
      { pattern: "*", permissions: ["admin"] },
    ]);
    return Response.json({ token });
  }

  // Production: serve built static files
  if (Bun.env.NODE_ENV === "production") {
    if (pathname === "/") {
      return new Response(Bun.file(distDir + "/index.html"));
    }
    const file = Bun.file(distDir + pathname);
    if (await file.exists()) {
      return new Response(file);
    }
  }

  return httpHandler(request);
}

export const websocket = handler.websocket;
