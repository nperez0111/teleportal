import type * as crossws from "crossws";
import { emitWideEvent } from "teleportal/server";

import {
  type BinaryMessage,
  type BinaryTransport,
  isBinaryMessage,
  type ServerContext,
} from "teleportal";
import type { Client, Server } from "teleportal/server";
import type { TokenManager } from "teleportal/token";
import { fromBinaryTransport } from "teleportal/transports";

declare module "crossws" {
  interface PeerContext {
    room: string;
    userId: string;
    clientId: string;
    transport: BinaryTransport;
    writer: WritableStreamDefaultWriter<BinaryMessage>;
    client: Client<ServerContext>;
  }
}

/**
 * This implements a websocket server based on the {@link crossws} library.
 * It is a low-level API for abstracting the websocket server implementation.
 *
 * By not bundling the {@link crossws} library, we can not have to install it
 */
export function getWebsocketHandlers<T extends ServerContext>({
  server,
  onUpgrade,
  onConnect,
  onDisconnect,
  onMessage,
}: {
  server: Server<T>;
  /**
   * Called when a client is attempting to upgrade to a websocket connection.
   *
   * @note You can reject the upgrade by throwing a {@link Response} object.
   */
  onUpgrade: (request: Request) => Promise<{
    context: Omit<T, "clientId">;
    headers?: Record<string, string>;
  }>;
  /**
   * Called when a client has connected to the server.
   */
  onConnect?: (ctx: {
    client: Client<T>;
    context: T;
    id: string;
    peer: crossws.Peer;
  }) => void | Promise<void>;
  /**
   * Called when a client has disconnected from the server.
   */
  onDisconnect?: (ctx: {
    client: Client<T>;
    context: T;
    id: string;
    peer: crossws.Peer;
  }) => void | Promise<void>;
  /**
   * Called when a client has sent a message to the server.
   */
  onMessage?: (ctx: {
    client: Client<T>;
    message: BinaryMessage;
    peer: crossws.Peer;
  }) => void | Promise<void>;
}): crossws.Hooks {
  return {
    async upgrade(request) {
      const startTime = Date.now();
      const wideEvent: Record<string, unknown> = {
        event_type: "websocket_upgrade",
        timestamp: new Date().toISOString(),
        request_url: request.url,
      };
      try {
        const { context, headers } = await onUpgrade(request);
        wideEvent.outcome = "success";
        wideEvent.status_code = 101;
        return {
          context: {
            ...context,
            clientId: "upgrade",
            transport: {} as any,
            writer: {} as any,
            client: {} as Client<ServerContext>,
          },
          headers: {
            "x-powered-by": "teleportal",
            ...headers,
          },
        };
      } catch (err) {
        wideEvent.outcome = "error";
        wideEvent.status_code = err instanceof Response ? err.status : 401;
        wideEvent.error = {
          type: err instanceof Error ? err.name : "Error",
          message: err instanceof Error ? err.message : String(err),
        };
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
      } finally {
        wideEvent.duration_ms = Date.now() - startTime;
        emitWideEvent(
          wideEvent.outcome === "error" ? "error" : "info",
          wideEvent,
        );
      }
    },
    async open(peer) {
      emitWideEvent("info", {
        event_type: "websocket_open",
        timestamp: new Date().toISOString(),
        client_id: peer.id,
      });
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
        peer.context.client = await server.createClient({
          transport: fromBinaryTransport(
            peer.context.transport,
            Object.assign({ clientId: peer.id }, peer.context) as unknown as T,
          ),
          id: peer.id,
        });

        await onConnect?.({
          client: peer.context.client as unknown as Client<T>,
          context: peer.context as any,
          id: peer.id,
          peer,
        });
      } catch (err) {
        emitWideEvent("error", {
          event_type: "websocket_connect_failed",
          timestamp: new Date().toISOString(),
          client_id: peer.id,
          error: {
            type: err instanceof Error ? err.name : "Error",
            message: err instanceof Error ? err.message : String(err),
          },
        });
        peer.close();
      }
    },
    async message(peer, msg) {
      const message = msg.uint8Array();
      if (!isBinaryMessage(message)) {
        throw new Error("Invalid message");
      }
      try {
        await onMessage?.({
          client: peer.context.client as unknown as Client<T>,
          message,
          peer,
        });
        await peer.context.writer.ready;
        await peer.context.writer.write(message);
      } catch (err) {
        emitWideEvent("error", {
          event_type: "websocket_write_failed",
          timestamp: new Date().toISOString(),
          client_id: peer.id,
          message_id: msg.id,
          error: {
            type: err instanceof Error ? err.name : "Error",
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
    },
    async close(peer) {
      emitWideEvent("info", {
        event_type: "websocket_close",
        timestamp: new Date().toISOString(),
        client_id: peer.id,
      });

      try {
        await onDisconnect?.({
          client: peer.context.client as unknown as Client<T>,
          context: peer.context as any,
          id: peer.id,
          peer,
        });
        await server.disconnectClient(peer.id);
        await peer.context.writer.close();
      } catch {
        // no-op
      }
      try {
        if (!peer.context.transport.writable.locked) {
          await peer.context.transport.writable.close();
        }
      } catch {
        // no-op
      }
    },
    async error(peer, error) {
      emitWideEvent("error", {
        event_type: "websocket_error",
        timestamp: new Date().toISOString(),
        client_id: peer.id,
        error,
      });
      await peer.context.writer.abort(error);
      await peer.context.transport.writable.abort(error);
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
  hooks?: Partial<Omit<Parameters<typeof getWebsocketHandlers>[0], "server">>;
}) {
  return getWebsocketHandlers<T>({
    server,
    onUpgrade: async (request) => {
      const url = new URL(request.url);
      const token = url.searchParams.get("token");
      const result = await tokenManager.verifyToken(token!);

      if (!result.valid || !result.payload) {
        throw new Response("Unauthorized", { status: 401 });
      }

      await hooks.onUpgrade?.(request);
      return {
        context: result.payload as T,
      };
    },
    onConnect: hooks.onConnect,
    onDisconnect: hooks.onDisconnect,
    onMessage: hooks.onMessage,
  });
}
