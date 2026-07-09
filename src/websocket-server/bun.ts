import { uuidv4 } from "lib0/random";

import {
  type BinaryMessage,
  type BinaryTransport,
  isBinaryMessage,
  type ServerContext,
} from "teleportal";
import type { Client, Server } from "teleportal/server";
import { emitWideEvent } from "teleportal/server";
import type { TokenManager } from "teleportal/token";
import { fromBinaryTransport } from "teleportal/transports";
import { createChannel } from "../lib/iter";

export interface BunWebSocketData {
  room: string;
  userId: string;
  clientId: string;
  appSlug?: string;
  transport: BinaryTransport;
  channel: ReturnType<typeof createChannel<BinaryMessage>>;
  client: Client<ServerContext>;
}

export function getBunWebsocketHandler<T extends ServerContext>({
  server,
  onUpgrade,
  onConnect,
  onDisconnect,
  appSlug,
}: {
  server: Server<T>;
  onUpgrade: (request: Request) => Promise<{
    context: Omit<T, "clientId">;
  }>;
  onConnect?: (ctx: { client: Client<T>; context: T; id: string }) => void | Promise<void>;
  onDisconnect?: (ctx: { client: Client<T>; context: T; id: string }) => void | Promise<void>;
  appSlug?: string;
}) {
  return {
    async upgrade(request: Request, bunServer: { upgrade: Function }) {
      const startTime = Date.now();
      const wideEvent: Record<string, unknown> = {
        event_type: "websocket_upgrade",
        timestamp: new Date().toISOString(),
        request_url: request.url,
      };
      try {
        const { context } = await onUpgrade(request);
        wideEvent.outcome = "success";
        wideEvent.status_code = 101;
        const ok = bunServer.upgrade(request, {
          data: {
            ...context,
            appSlug,
            clientId: "upgrade",
            transport: {} as any,
            channel: {} as any,
            client: {} as Client<ServerContext>,
          },
        });
        if (!ok) {
          return new Response("WebSocket upgrade failed", { status: 500 });
        }
        return undefined;
      } catch (err) {
        wideEvent.outcome = "error";
        wideEvent.status_code = err instanceof Response ? err.status : 401;
        wideEvent.error = {
          type: err instanceof Error ? err.name : "Error",
          message: err instanceof Error ? err.message : String(err),
        };
        if (err instanceof Response) {
          return err;
        }
        return new Response("Unauthorized", {
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

    websocket: {
      async open(ws: { data: BunWebSocketData; send: Function; close: Function }) {
        const clientId = "ws-" + uuidv4();
        emitWideEvent("info", {
          event_type: "websocket_open",
          timestamp: new Date().toISOString(),
          client_id: clientId,
        });

        const channel = createChannel<BinaryMessage>();
        ws.data.clientId = clientId;
        ws.data.channel = channel;
        ws.data.transport = {
          source: channel,
          write(chunk: BinaryMessage) {
            try {
              const result = ws.send(chunk);
              if (typeof result === "number" && result <= 0) {
                emitWideEvent("error", {
                  event_type: "websocket_send_backpressure",
                  timestamp: new Date().toISOString(),
                  client_id: clientId,
                  send_result: result,
                  chunk_bytes: chunk.byteLength,
                });
              }
            } catch (err) {
              emitWideEvent("error", {
                event_type: "websocket_send_threw",
                timestamp: new Date().toISOString(),
                client_id: clientId,
                chunk_bytes: chunk.byteLength,
                error: {
                  type: err instanceof Error ? err.name : "Error",
                  message: err instanceof Error ? err.message : String(err),
                },
              });
              throw err;
            }
          },
          close() {
            try {
              ws.close();
            } catch {
              // socket may already be closed
            }
          },
        };

        try {
          ws.data.client = (await server.createClient({
            transport: fromBinaryTransport(
              ws.data.transport,
              Object.assign({ clientId }, ws.data) as unknown as T,
            ),
            id: clientId,
          })) as unknown as Client<ServerContext>;

          await onConnect?.({
            client: ws.data.client as unknown as Client<T>,
            context: ws.data as any,
            id: clientId,
          });
        } catch (err) {
          emitWideEvent("error", {
            event_type: "websocket_connect_failed",
            timestamp: new Date().toISOString(),
            client_id: clientId,
            error: {
              type: err instanceof Error ? err.name : "Error",
              message: err instanceof Error ? err.message : String(err),
            },
          });
          ws.close();
        }
      },

      message(
        ws: { data: BunWebSocketData; close: Function },
        msg: ArrayBuffer | Uint8Array | string,
      ) {
        if (!ws.data.channel?.send || !ws.data.client) {
          emitWideEvent("info", {
            event_type: "websocket_stale_peer",
            timestamp: new Date().toISOString(),
            client_id: ws.data.clientId,
          });
          try {
            ws.close();
          } catch {
            // socket may already be closed
          }
          return;
        }
        const message = msg instanceof Uint8Array ? msg : new Uint8Array(msg as ArrayBuffer);
        if (!isBinaryMessage(message)) {
          throw new Error("Invalid message");
        }
        ws.data.channel.send(message);
      },

      async close(ws: { data: BunWebSocketData }) {
        emitWideEvent("info", {
          event_type: "websocket_close",
          timestamp: new Date().toISOString(),
          client_id: ws.data.clientId,
        });

        try {
          await onDisconnect?.({
            client: ws.data.client as unknown as Client<T>,
            context: ws.data as any,
            id: ws.data.clientId,
          });
        } catch {
          // onDisconnect failure must not prevent cleanup
        }
        try {
          server.disconnectClient(ws.data.clientId);
        } catch {
          // no-op
        }
        try {
          ws.data.channel?.close();
        } catch {
          // no-op
        }
        try {
          ws.data.transport?.close();
        } catch {
          // no-op
        }
      },

      drain(ws: { data: BunWebSocketData }) {
        emitWideEvent("debug", {
          event_type: "websocket_drain",
          timestamp: new Date().toISOString(),
          client_id: ws.data.clientId,
        });
      },
    },
  };
}

export function tokenAuthenticatedBunWebsocketHandler<T extends ServerContext>({
  server,
  tokenManager,
  appSlug,
}: {
  server: Server<T>;
  tokenManager: TokenManager;
  appSlug?: string;
}) {
  return getBunWebsocketHandler<T>({
    server,
    appSlug,
    onUpgrade: async (request) => {
      const url = new URL(request.url);
      const token = url.searchParams.get("token");
      const result = await tokenManager.verifyToken(token!);

      if (!result.valid || !result.payload) {
        throw new Response("Unauthorized", { status: 401 });
      }

      return {
        context: result.payload as Omit<T, "clientId">,
      };
    },
  });
}
