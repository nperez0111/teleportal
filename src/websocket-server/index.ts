import type * as crossws from "crossws";

import {
  type BinaryMessage,
  type ServerContext,
  type BinaryTransport,
  isBinaryMessage,
} from "teleportal";
import { fromBinaryTransport } from "../transports/utils";
import type { Server } from "teleportal/server";
import type { TokenManager } from "teleportal/token";
import type { Logger } from "teleportal/server";

declare module "crossws" {
  interface PeerContext {
    room: string;
    userId: string;
    clientId: string;
    transport: BinaryTransport;
    writer: WritableStreamDefaultWriter<BinaryMessage>;
  }
}

/**
 * This implements a websocket server based on the {@link crossws} library.
 * It is a low-level API for abstracting the websocket server implementation.
 *
 * By not bundling the {@link crossws} library, we can not have to install it
 */
export function getWebsocketHandlers<
  T extends Pick<crossws.PeerContext, "room" | "userId">,
>({
  onUpgrade,
  onConnect,
  onDisconnect,
  onMessage,
  logger,
}: {
  /**
   * Called when a client is attempting to upgrade to a websocket connection.
   *
   * @note You can reject the upgrade by throwing a {@link Response} object.
   */
  onUpgrade: (request: Request) => Promise<{
    context: T;
    headers?: Record<string, string>;
  }>;
  /**
   * Called when a client has connected to the server.
   */
  onConnect?: (ctx: {
    transport: BinaryTransport;
    context: T;
    id: string;
    peer: crossws.Peer;
  }) => void | Promise<void>;
  /**
   * Called when a client has disconnected from the server.
   */
  onDisconnect?: (ctx: {
    transport: BinaryTransport;
    context: T;
    id: string;
    peer: crossws.Peer;
  }) => void | Promise<void>;
  /**
   * Called when a client has sent a message to the server.
   */
  onMessage?: (ctx: {
    message: BinaryMessage;
    peer: crossws.Peer;
  }) => void | Promise<void>;
  logger: Logger;
}): {
  hooks: crossws.Hooks;
} {
  return {
    hooks: {
      async upgrade(request) {
        logger
          .withMetadata({ requestUrl: request.url })
          .info("upgrade websocket connection");
        try {
          const { context, headers } = await onUpgrade(request);

          return {
            context: {
              ...context,
              clientId: "upgrade",
              transport: {} as any,
              writer: {} as any,
            },
            headers: {
              "x-powered-by": "teleportal",
              ...headers,
            },
          };
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          logger
            .withError(error)
            .withMetadata({ requestUrl: request.url })
            .error("rejected upgrade websocket connection");
          if (err instanceof Response) {
            throw err;
          }
          throw new Response("Unauthorized", {
            status: 401,
            headers: {
              "WWW-Authenticate":
                'Basic realm="Websocket Authentication", charset="UTF-8"',
            },
          });
        }
      },
      async open(peer) {
        logger
          .withMetadata({ clientId: peer.id })
          .info("open websocket connection");
        const transform = new TransformStream<BinaryMessage, BinaryMessage>();

        peer.context.clientId = peer.id;
        peer.context.writer = transform.writable.getWriter();
        peer.context.transport = {
          readable: transform.readable,
          writable: new WritableStream({
            write(chunk) {
              peer.send(chunk);
            },
          }),
        };

        try {
          await onConnect?.({
            transport: peer.context.transport,
            context: peer.context as any,
            id: peer.id,
            peer,
          });
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          logger
            .withError(error)
            .withMetadata({ clientId: peer.id })
            .error("failed to connect");
          peer.close();
        }
      },
      async message(peer, msg) {
        logger
          .withMetadata({ clientId: peer.id, messageId: msg.id })
          .trace("message");
        const message = msg.uint8Array();
        if (!isBinaryMessage(message)) {
          throw new Error("Invalid message");
        }
        try {
          await onMessage?.({
            message,
            peer,
          });
          await peer.context.writer.ready;
          await peer.context.writer.write(message);
        } catch (e) {
          new Error("Failed to write message", { cause: { err: e } });
        }
      },
      async close(peer) {
        logger
          .withMetadata({ clientId: peer.id })
          .info("close websocket connection");
        await onDisconnect?.({
          transport: peer.context.transport,
          context: peer.context as any,
          id: peer.id,
          peer,
        });
        try {
          await peer.context.writer.close();
        } catch (e) {
          // no-op
        }
        try {
          if (!peer.context.transport.writable.locked) {
            await peer.context.transport.writable.close();
          }
        } catch (e) {
          // no-op
        }
      },
      async error(peer, error) {
        logger
          .withError(error)
          .withMetadata({ clientId: peer.id })
          .error("error");
        await peer.context.writer.abort(error);
        await peer.context.transport.writable.abort(error);
      },
    },
  };
}

/**
 * This is a websocket handler which implements token authentication.
 * It is a wrapper around the {@link getWebsocketHandlers} function.
 * You can pass `verifyToken` from the {@link TokenManager} to this function.
 * @example
 * ```ts
 * import { crossws } from "crossws";
 * import { tokenAuthenticatedWebsocketHandler } from "teleportal/websocket-server";
 * import { createTokenManager } from "teleportal/token";
 *
 * const tokenManager = createTokenManager({
 *   secret: "your-secret-key-here",
 * });
 *
 * const ws = crossws(
 *   tokenAuthenticatedWebsocketHandler({
 *     server,
 *     tokenManager,
 *   }),
 * );
 * ```
 */
export function tokenAuthenticatedWebsocketHandler<T extends ServerContext>({
  server,
  tokenManager,
  hooks = {},
}: {
  server: Server<T>;
  tokenManager: TokenManager;
  hooks?: Partial<Parameters<typeof getWebsocketHandlers>[0]>;
}) {
  return getWebsocketHandlers({
    onUpgrade: async (request) => {
      const url = new URL(request.url);
      const token = url.searchParams.get("token");
      const result = await tokenManager.verifyToken(token!);

      if (!result.valid || !result.payload) {
        throw new Response("Unauthorized", { status: 401 });
      }

      await hooks.onUpgrade?.(request);
      return {
        context: result.payload as unknown as Omit<T, "clientId">,
      };
    },
    onConnect: async (ctx) => {
      await hooks.onConnect?.(ctx);
      await server.createClient({
        transport: fromBinaryTransport(
          ctx.transport,
          Object.assign({ clientId: ctx.id }, ctx.context) as T,
        ),
        id: ctx.id,
      });
    },
    onDisconnect: async (ctx) => {
      await hooks.onDisconnect?.(ctx);
      await server.disconnectClient(ctx.id);
    },
    onMessage: async (ctx) => {
      await hooks.onMessage?.(ctx);
    },
    logger: server.logger,
  });
}
