import type { ServerContext, Message } from "teleportal";
import type { Server } from "teleportal/server";
import {
  getHTTPEndpoint,
  getSSEWriterEndpoint,
  getSSEReaderEndpoint,
  getStatusHandler,
  getMetricsHandler,
  getHealthHandler,
} from "./handlers";
import { TokenManager } from "teleportal/token";

/**
 * Creates an HTTP handler that can be used to handle HTTP requests to the {@link Server}.
 *
 * It sets up the following endpoints:
 * - GET `/sse` - SSE endpoint for streaming {@link Message}s to the client. (Based on {@link getSSEReaderEndpoint})
 * - POST `/sse` - HTTP endpoint for pushing {@link Message}s to the {@link getSSEReaderEndpoint}. (Based on {@link getSSEWriterEndpoint})
 * - POST `/message` - HTTP endpoint for directly handling {@link Message}s. (Based on {@link getHTTPEndpoint})
 * - GET `/health` - Health endpoint for checking the health of the server. (Based on {@link getHealthHandler})
 * - GET `/metrics` - Metrics endpoint for checking the metrics of the server. (Based on {@link getMetricsHandler})
 * - GET `/status` - Status endpoint for checking the status of the server. (Based on {@link getStatusHandler})
 *
 * @note if a request is not handled by any of the above endpoints, a `404` response is returned.
 */
export function getHTTPHandlers<Context extends ServerContext>({
  server,
  getContext,
  getInitialDocuments,
}: {
  server: Server<Context>;
  getContext: (
    request: Request,
  ) => Omit<Context, "clientId"> | Promise<Omit<Context, "clientId">>;
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

    if (req.method === "GET" && url.pathname === "/health") {
      return await getHealthHandler(server)(req);
    }
    if (req.method === "GET" && url.pathname === "/metrics") {
      return await getMetricsHandler(server)(req);
    }
    if (req.method === "GET" && url.pathname === "/status") {
      return await getStatusHandler(server)(req);
    }

    return new Response("Not Found", { status: 404 });
  };
}

/**
 * Creates an instance of {@link getHTTPHandlers} that is token authenticated.
 *
 * It extracts the token from the `Authorization` header (or `token` query parameter) and verifies it using the {@link TokenManager}.
 * If the token is invalid, a `401` response is returned.
 * If the token is valid, the context is returned.
 *
 * @example
 * ```ts
 * const tokenManager = createTokenManager({
 *   secret: "your-secret-key-here",
 * });
 *
 * const httpHandler = tokenAuthenticatedHTTPHandler({
 *   server,
 *   tokenManager,
 * });
 *
 * const instance = Bun.serve({
 *   fetch: httpHandler,
 * });
 *
 * console.info(`Server running on http://${instance.hostname}:${instance.port}`);
 * ```
 */
export function tokenAuthenticatedHTTPHandler({
  server,
  tokenManager,
}: {
  server: Server<ServerContext>;
  tokenManager: TokenManager;
}) {
  return getHTTPHandlers({
    server,
    getContext: async (request) => {
      const token =
        request.headers.get("authorization")?.replace("Bearer ", "") ??
        new URL(request.url).searchParams.get("token");

      if (!token) {
        throw new Response("Unauthorized", { status: 401 });
      }
      const result = await tokenManager.verifyToken(token!);
      if (!result.valid || !result.payload) {
        throw new Response("Unauthorized", { status: 401 });
      }
      return result.payload;
    },
  });
}
