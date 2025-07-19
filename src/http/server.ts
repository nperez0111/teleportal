import type { ServerContext, Message } from "teleportal";
import type { Server } from "teleportal/server";
import {
  getHTTPEndpoint,
  getHTTPPublishSSEEndpoint,
  getSSEEndpoint,
} from "./handlers";

/**
 * Creates an HTTP handler that can be used to handle HTTP requests to the {@link Server}.
 *
 * It sets up the following endpoints:
 * - GET `/sse` - SSE endpoint for streaming {@link Message}s to the client. (Based on {@link getSSEEndpoint})
 * - POST `/sse` - HTTP endpoint for pushing {@link Message}s to the {@link getSSEEndpoint}. (Based on {@link getHTTPPublishSSEEndpoint})
 * - POST `/message` - HTTP endpoint for directly handling {@link Message}s. (Based on {@link getHTTPEndpoint})
 *
 * @note if a request is not handled by any of the above endpoints, a `404` response is returned.
 */
export function getHTTPHandler<Context extends ServerContext>({
  server,
  getContext,
  getInitialDocuments,
}: {
  server: Server<Context>;
  getContext: (request: Request) => Promise<Omit<Context, "clientId">>;
  getInitialDocuments?: (
    request: Request,
  ) => { document: string; encrypted?: boolean }[];
}): (req: Request) => Response | Promise<Response> {
  const sseEndpoint = getSSEEndpoint({
    server,
    getContext,
    getInitialDocuments,
  });

  const httpPublishSSEEndpoint = getHTTPPublishSSEEndpoint({
    server,
    getContext,
  });

  const httpEndpoint = getHTTPEndpoint({
    server,
    getContext,
  });

  return async (req: Request) => {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/sse") {
      return await sseEndpoint(req);
    }

    if (req.method === "POST" && url.pathname === "/sse") {
      return await httpPublishSSEEndpoint(req);
    }

    if (req.method === "POST" && url.pathname === "/message") {
      return await httpEndpoint(req);
    }

    return new Response("Not Found", { status: 404 });
  };
}
