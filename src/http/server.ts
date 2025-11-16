import type { ServerContext, Message } from "teleportal";
import type { Server } from "teleportal/server";
import {
  getHTTPEndpoint,
  getSSEWriterEndpoint,
  getSSEReaderEndpoint,
} from "./handlers";

/**
 * Creates an HTTP handler that can be used to handle HTTP requests to the {@link Server}.
 *
 * It sets up the following endpoints:
 * - GET `/sse` - SSE endpoint for streaming {@link Message}s to the client. (Based on {@link getSSEReaderEndpoint})
 * - POST `/sse` - HTTP endpoint for pushing {@link Message}s to the {@link getSSEReaderEndpoint}. (Based on {@link getSSEWriterEndpoint})
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
  const sseReaderEndpoint = getSSEReaderEndpoint({
    server,
    getContext,
    getInitialDocuments,
  });

  const sseWriterEndpoint = getSSEWriterEndpoint({
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
      return await sseReaderEndpoint(req);
    }

    if (req.method === "POST" && url.pathname === "/sse") {
      return await sseWriterEndpoint(req);
    }

    if (req.method === "POST" && url.pathname === "/message") {
      return await httpEndpoint(req);
    }

    return new Response("Not Found", { status: 404 });
  };
}
