import type * as crossws from "crossws";

import type {
  BinaryMessage,
  ServerContext,
  YBinaryTransport,
} from "match-maker";
import { logger } from "./logger";

declare module "crossws" {
  interface PeerContext {
    room: string;
    userId: string;
    clientId: string;
    transport: YBinaryTransport;
    writable: WritableStream<BinaryMessage>;
  }
}

/**
 * This implements a websocket server based on the {@link crossws} library.
 *
 * By not bundling the {@link crossws} library, we can not have to install it
 */
export function getWebsocketHandlers({
  onUpgrade,
  onConnect,
  onDisconnect,
}: {
  /**
   * Called when a client is attempting to upgrade to a websocket connection.
   *
   * @note You can reject the upgrade by throwing a {@link Response} object.
   */
  onUpgrade: (request: Request) => Promise<{
    context: Pick<crossws.PeerContext, "room" | "userId">;
    headers?: Record<string, string>;
  }>;
  /**
   * Called when a client has connected to the server.
   */
  onConnect: (ctx: {
    transport: YBinaryTransport;
    context: ServerContext;
    id: string;
    peer: crossws.Peer;
  }) => void | Promise<void>;
  /**
   * Called when a client has disconnected from the server.
   */
  onDisconnect: (id: string) => void | Promise<void>;
}): {
  hooks: crossws.Hooks;
} {
  return {
    hooks: {
      async upgrade(request) {
        logger.info({ request }, "upgrade websocket connection");
        try {
          const { context, headers } = await onUpgrade(request);

          return {
            context: {
              ...context,
              clientId: "upgrade",
              transport: {} as any,
              writable: {} as any,
            },
            headers: {
              "x-powered-by": "match-maker",
              ...headers,
            },
          };
        } catch (err) {
          logger.error({ err }, "rejected upgrade websocket connection");
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
        logger.info({ peerId: peer.id }, "open websocket connection");
        const transform = new TransformStream<BinaryMessage, BinaryMessage>();

        peer.context.clientId = peer.id;
        peer.context.writable = transform.writable;
        peer.context.transport = {
          readable: transform.readable,
          writable: new WritableStream({
            write(chunk) {
              peer.send(chunk);
            },
          }),
        };

        await onConnect({
          transport: peer.context.transport,
          context: peer.context,
          id: peer.id,
          peer,
        });
      },
      async message(peer, message) {
        logger.trace({ peerId: peer.id, messageId: message.id }, "message");
        const buff = message.uint8Array();
        try {
          const writer = peer.context.writable.getWriter();
          await writer.write(buff as BinaryMessage);
          writer.releaseLock();
        } catch (e) {
          peer.close();
        }
      },
      async close(peer) {
        logger.info({ peerId: peer.id }, "close websocket connection");
        await onDisconnect(peer.id);
        if (!peer.context.writable.locked) {
          await peer.context.writable.close();
        }
        if (!peer.context.transport.writable.locked) {
          await peer.context.transport.writable.close();
        }
      },
      async error(peer, error) {
        logger.error({ peerId: peer.id, error }, "error");
        await peer.context.writable.abort(error);
        await peer.context.transport.writable.abort(error);
      },
    },
  };
}
