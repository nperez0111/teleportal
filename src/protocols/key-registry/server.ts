import { createHandlers, ok, err, type RpcHandlerRegistry } from "teleportal/rpc";
import type { KeyRegistryStorage } from "./storage";
import { keyRegistryProtocol } from "./methods";

type KeyRegistryDeps = {
  storage: KeyRegistryStorage;
};

export function getKeyRegistryRpcHandlers(storage: KeyRegistryStorage): RpcHandlerRegistry {
  const deps: KeyRegistryDeps = { storage };

  return createHandlers(keyRegistryProtocol, deps, {
    get:
      ({ storage }) =>
      async (_payload, context) => {
        const userId = context.userId as string | undefined;
        if (!userId) {
          return err(401, "userId required in message context");
        }
        const record = await storage.get(context.documentId, userId);
        if (!record) {
          return err(404, "No wrapped key found for this user");
        }
        return ok({
          wrappedKey: record.wrappedKey,
          generation: record.generation,
        });
      },

    set:
      ({ storage }) =>
      async (payload, context) => {
        const generation = await storage.set(context.documentId, payload.entries);
        return ok({ generation });
      },

    revoke:
      ({ storage }) =>
      async (payload, context) => {
        const generation = await storage.revoke(context.documentId, payload.userIds);
        return ok({ generation });
      },

    meta:
      ({ storage }) =>
      async (_payload, context) => {
        const meta = await storage.getMeta(context.documentId);
        return ok({ generation: meta.generation, userIds: meta.userIds });
      },

    rotate:
      ({ storage }) =>
      async (payload, context) => {
        let generation: number;
        try {
          generation = await storage.rotate(
            context.documentId,
            payload.entries,
            payload.expectedGeneration,
          );
        } catch (e: any) {
          if (e.message?.includes("conflict")) {
            return err(409, e.message);
          }
          throw e;
        }

        // Tell the other clients on this document to re-fetch the key. Local-only: the new
        // generation is already in the shared registry, so every node notifies its own.
        await context.session.broadcastRpc(
          keyRegistryProtocol.methods.rotated.name,
          { generation },
          { excludeClientId: context.clientId as string },
        );

        return ok({ generation });
      },

    // The only legitimate `rotated` push is the one the `rotate` handler above sends via
    // `broadcastRpc`, which reaches local clients directly and never routes through here.
    // So anything arriving at this handler was authored by a client — and relaying it would
    // let anyone on the document make every peer discard its key and re-fetch. Drop it.
    // (`replicate: false` restates this method's QoS: the forgery must not reach the
    // node-to-node plane, where other nodes would treat it as server-authored.)
    rotated: () => () => ({ forwardToLocalClients: false, replicate: false }),
  });
}
