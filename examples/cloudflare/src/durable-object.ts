import crossws from "crossws/adapters/cloudflare";

import {
  DurableObjectDocumentStorage,
  DurableObjectFileStorage,
  DurableObjectKeyRegistryStorage,
  DurableObjectMilestoneStorage,
  DurableObjectRateLimitStorage,
  DurableObjectTemporaryUploadStorage,
  type DurableObjectStateLike,
  getDurableObjectHandlers,
  getDurableObjectWebsocketHooks,
} from "teleportal/cloudflare";
import { getHTTPHandlers } from "teleportal/http";
import { getAttributionRpcHandlers } from "teleportal/protocols/attribution";
import { getFileRpcHandlers } from "teleportal/protocols/file";
import { getKeyRegistryRpcHandlers } from "teleportal/protocols/key-registry";
import { getMilestoneRpcHandlers } from "teleportal/protocols/milestone";
import { Server } from "teleportal/server";
import { defaultRateLimitRules } from "teleportal/transports/rate-limiter";

/**
 * Static context for every connection — this example runs without
 * authentication. Swap in `tokenAuthenticatedWebsocketHandler` /
 * `tokenAuthenticatedHTTPHandler` with a `TokenManager` for real deployments
 * (jose runs fine on workerd).
 */
const CONTEXT = { userId: "cloudflare-demo", room: "docs" };

export class TeleportalDurableObject {
  /** crossws reads the DurableObjectState from `.ctx`. */
  ctx: DurableObjectStateLike;
  env: unknown;
  #handlers: ReturnType<typeof getDurableObjectHandlers>;

  constructor(state: DurableObjectStateLike, env: unknown) {
    this.ctx = state;
    this.env = env;

    const storage = state.storage;
    const temporaryUploadStorage = new DurableObjectTemporaryUploadStorage(storage);
    const fileStorage = new DurableObjectFileStorage(storage, { temporaryUploadStorage });
    const milestoneStorage = new DurableObjectMilestoneStorage(storage);
    const keyRegistryStorage = new DurableObjectKeyRegistryStorage(storage);
    const rateLimitStorage = new DurableObjectRateLimitStorage(storage);

    const server = new Server<typeof CONTEXT & { clientId: string }>({
      storage: async (ctx) =>
        new DurableObjectDocumentStorage(storage, {
          keyPrefix: "document",
          encrypted: ctx.encrypted,
        }),
      rpcHandlers: {
        ...getMilestoneRpcHandlers(milestoneStorage),
        ...getFileRpcHandlers(fileStorage),
        ...getAttributionRpcHandlers(),
        ...getKeyRegistryRpcHandlers(keyRegistryStorage),
      },
      rateLimitConfig: {
        rules: defaultRateLimitRules(),
        rateLimitStorage,
        maxMessageSize: 10 * 1024 * 1024, // 10MB
        getUserId: (message) => message.context?.userId,
        getDocumentId: (message) => message.document,
      },
    });

    this.#handlers = getDurableObjectHandlers({
      ws: crossws({
        hooks: getDurableObjectWebsocketHooks({
          server,
          onUpgrade: async () => ({ context: CONTEXT }),
        }),
      }),
      http: getHTTPHandlers({ server, getContext: () => CONTEXT }),
    });
  }

  fetch(request: Request): Response | Promise<Response> {
    return this.#handlers.fetch(this, request);
  }

  webSocketMessage(ws: unknown, message: ArrayBuffer | string): Promise<void> {
    return this.#handlers.webSocketMessage(this, ws, message);
  }

  webSocketClose(ws: unknown, code: number, reason: string, wasClean: boolean): Promise<void> {
    return this.#handlers.webSocketClose(this, ws, code, reason, wasClean);
  }
}
