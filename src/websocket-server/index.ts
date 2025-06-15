import type * as crossws from "crossws";
import { PeerContext } from "crossws";
import type { BinaryMessage, ServerContext, YBinaryTransport } from "../lib";
import { Server } from "../server/server";

declare module "crossws" {
  interface PeerContext {
    room: string;
    userId: string;
    transport: YBinaryTransport;
    writable: WritableStream<BinaryMessage>;
  }
}

export function createHandler(
  server: Server<ServerContext>,
  {
    onUpgrade,
  }: {
    onUpgrade: (request: Request) => Promise<{
      context: Pick<PeerContext, "room" | "userId">;
      headers?: Record<string, string>;
    }>;
  },
): {
  hooks: crossws.Hooks;
} {
  return {
    hooks: {
      async upgrade(request) {
        try {
          const { context, headers } = await onUpgrade(request);

          return {
            context: {
              ...context,
              transport: {} as any,
              writable: {} as any,
            },
            headers,
          };
        } catch (err) {
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
      open(peer) {
        console.log("open", peer);
        const transform = new TransformStream<BinaryMessage, BinaryMessage>();

        peer.context.writable = transform.writable;
        peer.context.transport = {
          readable: transform.readable,
          writable: new WritableStream({
            write(chunk) {
              peer.send(chunk);
            },
          }),
        };
        server.createClient(peer.context.transport, peer.context);
      },
      async message(peer, message) {
        console.log("message", peer.id, message.text());
        const buff = message.uint8Array();
        const writer = peer.context.writable.getWriter();
        await writer.write(buff as BinaryMessage);
        writer.releaseLock();
      },
      async close(peer) {
        console.log("close", peer);
        await peer.context.writable.close();
        await peer.context.transport.writable.close();
      },
      error(peer, error) {
        console.log("error", peer, error);
      },
    },
  };
}
