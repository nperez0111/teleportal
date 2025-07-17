import { ServerContext } from "teleportal";
import { Server } from "teleportal/server";
import { getHTTPEndpoint, getSSEHandler } from "./handlers";

export function getHandlers<Context extends ServerContext>({
  server,
  validateRequest,
  getDocumentsToSubscribe,
}: {
  server: Server<Context>;
  validateRequest: (request: Request) => Promise<Omit<Context, "clientId">>;
  getDocumentsToSubscribe?: (
    request: Request,
  ) => { document: string; encrypted?: boolean }[];
}): (req: Request) => Response | Promise<Response> {
  const sseEndpoint = getSSEHandler({
    server,
    validateRequest,
    getDocumentsToSubscribe,
  });

  const httpEndpoint = getHTTPEndpoint({
    server,
    validateRequest,
  });

  return async (req: Request) => {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/sse") {
      return await sseEndpoint(req);
    }

    if (req.method === "POST" && url.pathname === "/message") {
      return await httpEndpoint(req);
    }

    return new Response("Not Found", { status: 404 });
  };
}
