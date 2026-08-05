import { createStorage } from "unstorage";

import { RpcMessage } from "teleportal/protocol";
import { tokenAuthenticatedHTTPHandler } from "teleportal/http";
import {
  getKeyRegistryRpcHandlers,
  getKeyRegistryHandlers,
} from "teleportal/protocols/key-registry";
import { Server, checkPermissionWithTokenManager } from "teleportal/server";
import { UnstorageDocumentStorage, UnstorageKeyRegistryStorage } from "teleportal/storage";
import { createTokenManager, type TokenPayload } from "teleportal/token";
import { tokenAuthenticatedBunWebsocketHandler } from "teleportal/websocket-server/bun";

export const manifest = {
  slug: "access-control",
  title: "Access Control",
  description: "Per-user E2E encryption with live grant, revoke, and key rotation",
  tags: ["encryption", "keys", "access-control", "react"],
};

export { default as html } from "./src/index.html";

const DOCUMENT_ID = "shared-notes";
const ROOM = "access-control";
const MASTER_SECRET = new TextEncoder().encode("access-control-demo-master-secret");

const memoryStorage = createStorage();

const keyRegistryStorage = new UnstorageKeyRegistryStorage(memoryStorage, {
  keyPrefix: "key-registry",
});

const tokenManager = createTokenManager({
  secret: "access-control-demo-secret",
  expiresIn: 3600,
  issuer: "access-control-demo",
});

const server = new Server<TokenPayload & { clientId: string }>({
  storage: async (ctx) =>
    new UnstorageDocumentStorage(memoryStorage, {
      keyPrefix: "document",
      encrypted: ctx.encrypted,
    }),
  rpcHandlers: {
    ...getKeyRegistryRpcHandlers(keyRegistryStorage),
  },
  checkPermission: checkPermissionWithTokenManager(tokenManager),
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
          "key-registry.rotated",
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
});

type UserDef = { userId: string; displayName: string; role: string };

const DEFAULT_USERS: UserDef[] = [
  { userId: "alice", displayName: "Alice", role: "admin" },
  { userId: "bob", displayName: "Bob", role: "editor" },
  { userId: "eve", displayName: "Eve", role: "viewer" },
];

function mintToken(userId: string): Promise<string> {
  return tokenManager.createToken(userId, ROOM, [{ pattern: "*", permissions: ["admin"] }]);
}

async function callKeyHandler(
  method: string,
  action: string,
  body: Record<string, unknown>,
): Promise<any> {
  const url = `http://localhost/keys/${DOCUMENT_ID}/${action}`;
  const req = new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, room: ROOM }),
  });
  const res = await keyHandlers(req);
  return res.json();
}

export async function fetch(request: Request, bunServer: any) {
  if (request.headers.get("upgrade") === "websocket") {
    return handler.upgrade(request, bunServer);
  }

  const url = new URL(request.url);
  const pathname = url.pathname;

  if (pathname === "/api/setup" && request.method === "POST") {
    const compositeDocId = `${ROOM}/${DOCUMENT_ID}`;
    const meta = await keyRegistryStorage.getMeta(compositeDocId);
    const isInitialized = meta.userIds.length > 0;

    const users: Record<
      string,
      { token: string; wrappingKey: string; role: string; displayName: string }
    > = {};

    if (!isInitialized) {
      const mintResult = await callKeyHandler("POST", "mint", {
        userId: DEFAULT_USERS[0].userId,
      });
      const firstToken = await mintToken(DEFAULT_USERS[0].userId);
      users[DEFAULT_USERS[0].userId] = {
        token: firstToken,
        wrappingKey: mintResult.wrappingKey,
        role: DEFAULT_USERS[0].role,
        displayName: DEFAULT_USERS[0].displayName,
      };

      const remainingUserIds = DEFAULT_USERS.slice(1).map((u) => u.userId);
      const grantResult = await callKeyHandler("POST", "grant", {
        userIds: remainingUserIds,
      });
      for (const userDef of DEFAULT_USERS.slice(1)) {
        const token = await mintToken(userDef.userId);
        users[userDef.userId] = {
          token,
          wrappingKey: grantResult.wrappingKeys[userDef.userId],
          role: userDef.role,
          displayName: userDef.displayName,
        };
      }
    } else {
      for (const userDef of DEFAULT_USERS) {
        const hasKey = meta.userIds.includes(userDef.userId);
        if (!hasKey) continue;
        const token = await mintToken(userDef.userId);
        const grantResult = await callKeyHandler("POST", "grant", {
          userId: userDef.userId,
        });
        users[userDef.userId] = {
          token,
          wrappingKey: grantResult.wrappingKey,
          role: userDef.role,
          displayName: userDef.displayName,
        };
      }
    }

    return Response.json({
      documentId: DOCUMENT_ID,
      room: ROOM,
      users,
    });
  }

  if (pathname === "/api/revoke" && request.method === "POST") {
    const { userId } = (await request.json()) as { userId: string };
    const result = await callKeyHandler("DELETE", "revoke", {
      userIds: [userId],
    });
    return Response.json({
      success: true,
      generation: result.generation,
    });
  }

  if (pathname === "/api/rotate" && request.method === "POST") {
    const { excludeUserIds = [] } = (await request.json()) as {
      excludeUserIds?: string[];
    };
    const rotateResult = await callKeyHandler("POST", "rotate", {
      excludeUserIds,
    });
    return Response.json({
      success: true,
      generation: rotateResult.generation,
    });
  }

  if (pathname === "/api/restore" && request.method === "POST") {
    const { userId, role } = (await request.json()) as {
      userId: string;
      role: string;
    };
    const grantResult = await callKeyHandler("POST", "grant", {
      userId,
    });
    const token = await mintToken(userId);
    return Response.json({
      token,
      wrappingKey: grantResult.wrappingKey,
      role,
    });
  }

  if (pathname === "/api/meta" && request.method === "GET") {
    const compositeDocId = `${ROOM}/${DOCUMENT_ID}`;
    const meta = await keyRegistryStorage.getMeta(compositeDocId);
    return Response.json(meta);
  }

  if (pathname === "/api/token" && request.method === "POST") {
    const { userId } = (await request.json()) as { userId: string };
    const token = await mintToken(userId);
    return Response.json({ token });
  }

  return httpHandler(request);
}

export const websocket = handler.websocket;
