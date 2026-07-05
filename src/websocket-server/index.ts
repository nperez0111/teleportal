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
import { createChannel } from "../lib/iter";

declare module "crossws" {
  interface PeerContext {
    room: string;
    userId: string;
    clientId: string;
    transport: BinaryTransport;
    channel: ReturnType<typeof createChannel<BinaryMessage>>;
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
            channel: {} as any,
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
            "WWW-Authenticate": 'Basic realm="Websocket Authentication", charset="UTF-8"',
          },
        });
      } finally {
        wideEvent.duration_ms = Date.now() - startTime;
        emitWideEvent(wideEvent.outcome === "error" ? "error" : "info", wideEvent);
      }
    },
    async open(peer) {
      emitWideEvent("info", {
        event_type: "websocket_open",
        timestamp: new Date().toISOString(),
        client_id: peer.id,
      });

      const channel = createChannel<BinaryMessage>();

      peer.context.clientId = peer.id;
      peer.context.channel = channel;
      peer.context.transport = {
        source: channel,
        write(chunk: BinaryMessage) {
          // Bun's ws.send returns -1 (backpressure: queued) or 0 (dropped)
          // instead of the byte count. A dropped broadcast here is a silent
          // server→client update loss that parks the receiver's ydoc until
          // its next resync, so surface any non-positive result.
          try {
            const result = peer.send(chunk);
            if (typeof result === "number" && result <= 0) {
              emitWideEvent("error", {
                event_type: "websocket_send_backpressure",
                timestamp: new Date().toISOString(),
                client_id: peer.id,
                send_result: result,
                buffered_amount: peer.websocket?.bufferedAmount,
                chunk_bytes: chunk.byteLength,
              });
            }
          } catch (err) {
            emitWideEvent("error", {
              event_type: "websocket_send_threw",
              timestamp: new Date().toISOString(),
              client_id: peer.id,
              chunk_bytes: chunk.byteLength,
              error: {
                type: err instanceof Error ? err.name : "Error",
                message: err instanceof Error ? err.message : String(err),
              },
            });
            throw err;
          }
        },
        // Called by the server when it can no longer service this connection
        // (consume loop ended). Closing the socket makes the client reconnect
        // immediately instead of waiting out its receive timeout on a wedged
        // connection.
        close() {
          try {
            peer.close();
          } catch {
            // ignore — the socket may already be closed
          }
        },
      };

      try {
        peer.context.client = (await server.createClient({
          transport: fromBinaryTransport(
            peer.context.transport,
            Object.assign({ clientId: peer.id }, peer.context) as unknown as T,
          ),
          id: peer.id,
        })) as unknown as Client<ServerContext>;

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
      peer.context.channel.send(message);
      try {
        await onMessage?.({
          client: peer.context.client as unknown as Client<T>,
          message,
          peer,
        });
      } catch (err) {
        emitWideEvent("error", {
          event_type: "websocket_message_hook_failed",
          timestamp: new Date().toISOString(),
          client_id: peer.id,
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
      } catch {
        // onDisconnect hook failure must not prevent cleanup
      }
      try {
        server.disconnectClient(peer.id);
      } catch {
        // no-op
      }
      try {
        peer.context.channel.close();
      } catch {
        // no-op
      }
      try {
        peer.context.transport.close();
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
      peer.context.channel.error(error);
    },
    drain(peer) {
      emitWideEvent("debug", {
        event_type: "websocket_drain",
        timestamp: new Date().toISOString(),
        client_id: peer.id,
        buffered_amount: peer.websocket?.bufferedAmount,
      });
    },
    ping(peer) {
      emitWideEvent("debug", {
        event_type: "websocket_ping",
        timestamp: new Date().toISOString(),
        client_id: peer.id,
      });
    },
    pong(peer) {
      emitWideEvent("debug", {
        event_type: "websocket_pong",
        timestamp: new Date().toISOString(),
        client_id: peer.id,
      });
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
  hooks?: Partial<Omit<Parameters<typeof getWebsocketHandlers<T>>[0], "server">>;
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
