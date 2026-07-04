/**
 * Playground server backed by the first-party Postgres storage adapters
 * (documents, milestones, rate limits, key registry) and S3 file storage
 * (MinIO locally by default; point S3_* env vars at R2/AWS for the real thing).
 *
 * Start Postgres and MinIO:
 *   docker run -d -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:17-alpine
 *   docker run -d -p 9000:9000 minio/minio server /data
 *
 * Then: `bun run dev:postgres` and open http://localhost:1237
 */

import crossws from "crossws/adapters/bun";
import postgres from "postgres";

import { getAttributionRpcHandlers } from "teleportal/protocols/attribution";
import { getFileRpcHandlers } from "teleportal/protocols/file";
import { getMilestoneRpcHandlers } from "teleportal/protocols/milestone";
import {
  getKeyRegistryRpcHandlers,
  getKeyRegistryHandlers,
} from "teleportal/protocols/key-registry";
import { Server, checkPermissionWithTokenManager } from "teleportal/server";
import { TieredRateLimitStorage } from "teleportal/storage";
import {
  PostgresDocumentStorage,
  PostgresKeyRegistryStorage,
  PostgresMilestoneStorage,
  PostgresRateLimitStorage,
  ensureSchema,
  type Sql,
} from "teleportal/storage/postgres";
import { S3FileStorage, S3Http, S3TemporaryUploadStorage } from "teleportal/storage/s3";
import { createTokenManager, TokenPayload } from "teleportal/token";
import { defaultRateLimitRules } from "teleportal/transports/rate-limiter";
import { tokenAuthenticatedWebsocketHandler } from "teleportal/websocket-server";
import { tokenAuthenticatedHTTPHandler } from "teleportal/http";

import "../src/backend/logger";

import homepage from "../src/index.html";

// ── SharedWorker bundle (same as the default playground server) ────────────
const workerOutDir = import.meta.dir + "/../.worker-dist";
const workerSrc = import.meta.dir + "/../src/worker.ts";
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

// ── Postgres ────────────────────────────────────────────────────────────────
const POSTGRES_URL = Bun.env.POSTGRES_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
const TABLE_PREFIX = "playground_";

// One pool for everything. Each adapter lazily reserves a single dedicated
// advisory-lock connection, so keep max comfortably above the adapter count.
const sql = postgres(POSTGRES_URL, { max: 10, onnotice: () => {} }) as unknown as Sql & {
  end(): Promise<void>;
};
await ensureSchema(sql, { tablePrefix: TABLE_PREFIX });
console.info(`Postgres storage ready at ${POSTGRES_URL} (prefix "${TABLE_PREFIX}")`);

// The adapters are stateless per document, so ONE long-lived instance per
// encryption mode serves every connection — never construct one per session
// (each instance reserves a lock connection from the pool).
const encryptedDocuments = new PostgresDocumentStorage(sql, {
  tablePrefix: TABLE_PREFIX,
  encrypted: true,
});
const plainDocuments = new PostgresDocumentStorage(sql, {
  tablePrefix: TABLE_PREFIX,
  encrypted: false,
});
const milestoneStorage = new PostgresMilestoneStorage(sql, { tablePrefix: TABLE_PREFIX });
const keyRegistryStorage = new PostgresKeyRegistryStorage(sql, { tablePrefix: TABLE_PREFIX });
// Per-message reads served from an in-memory LRU; Postgres is the durable tier.
const postgresRateLimits = new PostgresRateLimitStorage(sql, { tablePrefix: TABLE_PREFIX });
const rateLimitStorage = new TieredRateLimitStorage(postgresRateLimits);

// ── Files: S3 (MinIO locally by default, R2/AWS via env) ───────────────────
const S3_ENDPOINT = Bun.env.S3_ENDPOINT ?? "http://localhost:9000";
const s3 = new S3Http({
  endpoint: S3_ENDPOINT,
  bucket: Bun.env.S3_BUCKET ?? "teleportal-playground",
  region: Bun.env.S3_REGION ?? "us-east-1",
  accessKeyId: Bun.env.S3_ACCESS_KEY_ID ?? "minioadmin",
  secretAccessKey: Bun.env.S3_SECRET_ACCESS_KEY ?? "minioadmin",
});
await s3.ensureBucket();
const temporaryUploadStorage = new S3TemporaryUploadStorage(s3);
const fileStorage = new S3FileStorage(s3, { temporaryUploadStorage });
console.info(`File storage on S3 at ${S3_ENDPOINT} (bucket "${s3.bucket}")`);

// ── Server (same auth/RPC wiring as the default playground server) ─────────
const MASTER_SECRET = new TextEncoder().encode("playground-master-secret-change-in-production");

const tokenManager = createTokenManager({
  secret: "your-secret-key-here", // In production, use a strong secret
  expiresIn: 3600, // 1 hour
  issuer: "my-collaborative-app",
});

const rateLimitRules = defaultRateLimitRules<TokenPayload & { clientId: string }>();

const server = new Server<TokenPayload & { clientId: string }>({
  storage: async (ctx) => (ctx.encrypted ? encryptedDocuments : plainDocuments),
  rpcHandlers: {
    ...getMilestoneRpcHandlers(milestoneStorage),
    ...getFileRpcHandlers(fileStorage),
    ...getAttributionRpcHandlers(),
    ...getKeyRegistryRpcHandlers(keyRegistryStorage),
  },
  checkPermission: checkPermissionWithTokenManager(tokenManager),
  rateLimitConfig: {
    rules: rateLimitRules,
    rateLimitStorage,
    maxMessageSize: 10 * 1024 * 1024, // 10MB
    getUserId: (message) => message.context?.userId,
    getDocumentId: (message) => message.document,
  },
});

const ws = crossws({
  hooks: tokenAuthenticatedWebsocketHandler({
    server,
    tokenManager,
  }),
});

const keyHandlers = getKeyRegistryHandlers({
  storage: keyRegistryStorage,
  masterSecret: MASTER_SECRET,
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

const instance = Bun.serve({
  development: {
    // hmr: false,
  },
  routes:
    Bun.env.NODE_ENV !== "production"
      ? {
          // In development, serve the homepage
          "/": homepage,
        }
      : undefined,
  websocket: ws.websocket,
  async fetch(request, bunServer) {
    if (request.headers.get("upgrade") === "websocket") {
      return ws.handleUpgrade(request, bunServer);
    }

    const url = new URL(request.url);
    const pathname = url.pathname;
    const distDir = import.meta.dir + "/../dist";

    // Just serve the index.html file for the root path
    if (pathname === "/") {
      return new Response(Bun.file(distDir + "/index.html"));
    }

    if (pathname === "/worker.js") {
      return new Response(Bun.file(workerOutDir + "/worker.js"), {
        headers: { "Content-Type": "application/javascript" },
      });
    }

    // Token API — frontend requests a token from the backend
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

    // Look in the dist folder for the file
    const filePath = distDir + pathname;
    const file = Bun.file(filePath);

    if (await file.exists()) {
      return new Response(file);
    }

    // Otherwise, check if the request is handled by the HTTP handler
    return httpHandler(request);
  },
});

console.info(`Postgres playground server running on http://${instance.hostname}:${instance.port}`);

// Release advisory-lock connections and the pool on shutdown.
async function shutdown() {
  await Promise.all([
    encryptedDocuments.close(),
    plainDocuments.close(),
    keyRegistryStorage.close(),
    postgresRateLimits.close(),
  ]);
  await sql.end();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
