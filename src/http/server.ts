import { ServerContext } from "teleportal";
import { Server } from "teleportal/server";
import { getHTTPEndpoint, getSSEHandler } from "./handlers";

export function getHandlers<Context extends ServerContext>({
  server,
}: {
  server: Server<Context>;
}): (req: Request) => Response | Promise<Response> {
  const sseEndpoint = getSSEHandler({
    server,
    validateRequest: async (req) => {
      return { userId: "test", room: "test" } as Context;
    },
  });
  const httpEndpoint = getHTTPEndpoint({
    server,
    validateRequest: async (req) => {
      return { userId: "test", room: "test" } as Context;
    },
  });

  return async (req: Request) => {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/sse") {
      return sseEndpoint(req);
    }

    if (req.method === "POST" && url.pathname === "/message") {
      return httpEndpoint(req);
    }

    return new Response("Not Found", { status: 404 });
  };
}
