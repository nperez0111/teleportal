import {
  generateEncryptionKey,
  deriveWrappingKey,
  wrapDocumentKey,
  unwrapDocumentKey,
  exportWrappingKey,
} from "teleportal/encryption-key";
import type { KeyRegistryStorage } from "./storage";

export function getKeyRegistryHandlers({
  storage,
  masterSecret,
  authorize,
}: {
  storage: KeyRegistryStorage;
  masterSecret: Uint8Array;
  authorize?: (req: Request, documentId: string, action: string) => Promise<boolean> | boolean;
}) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const match = url.pathname.match(/^\/keys\/([^/]+)\/(\w+)$/);
    if (!match) return new Response("Not Found", { status: 404 });

    const [, rawDocumentId, action] = match;

    // Parse body once for non-GET requests
    let body: any = {};
    if (req.method !== "GET") {
      body = await req.json();
    }

    // When a `room` is provided, construct the composite document ID
    // that matches the server's namespaced session IDs.
    const documentId = body.room ? `${body.room}/${rawDocumentId}` : rawDocumentId;

    if (authorize && !(await authorize(req, documentId, action))) {
      return new Response("Forbidden", { status: 403 });
    }

    try {
      switch (action) {
        case "mint": {
          const { userId } = body as { userId: string };
          const documentKey = await generateEncryptionKey();
          const wrappingKey = await deriveWrappingKey(masterSecret, userId);
          const wrappedKey = await wrapDocumentKey(wrappingKey, documentKey);
          const generation = await storage.set(documentId, [{ userId, wrappedKey }]);
          return Response.json({
            generation,
            wrappingKey: await exportWrappingKey(wrappingKey),
          });
        }

        case "grant": {
          const userIds = body.userIds ?? (body.userId ? [body.userId] : []);
          if (userIds.length === 0) {
            return Response.json({ error: "userId or userIds required" }, { status: 400 });
          }

          const existing = await storage.getAny(documentId);
          if (!existing) {
            return Response.json(
              { error: "No key exists for this document — mint first" },
              { status: 404 },
            );
          }
          const existingWK = await deriveWrappingKey(masterSecret, existing.userId);
          const documentKey = await unwrapDocumentKey(existingWK, existing.wrappedKey);

          const wrappingKeys: Record<string, string> = {};
          const entries: { userId: string; wrappedKey: Uint8Array }[] = [];
          for (const userId of userIds) {
            const wk = await deriveWrappingKey(masterSecret, userId);
            entries.push({
              userId,
              wrappedKey: await wrapDocumentKey(wk, documentKey),
            });
            wrappingKeys[userId] = await exportWrappingKey(wk);
          }
          await storage.set(documentId, entries);

          if (body.userId) {
            return Response.json({
              wrappingKey: wrappingKeys[body.userId],
            });
          }
          return Response.json({ wrappingKeys });
        }

        case "revoke": {
          const { userIds } = body as { userIds: string[] };
          const generation = await storage.revoke(documentId, userIds);
          return Response.json({ generation });
        }

        case "rotate": {
          const { excludeUserIds = [] } = body as {
            excludeUserIds?: string[];
          };
          const meta = await storage.getMeta(documentId);
          const newDocKey = await generateEncryptionKey();

          const remainingUserIds = meta.userIds.filter((id) => !excludeUserIds.includes(id));
          const entries = await Promise.all(
            remainingUserIds.map(async (userId) => ({
              userId,
              wrappedKey: await wrapDocumentKey(
                await deriveWrappingKey(masterSecret, userId),
                newDocKey,
              ),
            })),
          );

          const generation = await storage.rotate(documentId, entries, meta.generation);
          return Response.json({ generation });
        }

        case "meta": {
          const meta = await storage.getMeta(documentId);
          return Response.json(meta);
        }

        default:
          return new Response("Not Found", { status: 404 });
      }
    } catch (e: any) {
      if (e.message?.includes("conflict")) {
        return Response.json({ error: e.message }, { status: 409 });
      }
      return Response.json({ error: e.message ?? "Internal error" }, { status: 500 });
    }
  };
}
