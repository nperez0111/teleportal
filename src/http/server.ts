import { ServerContext } from "teleportal";
import { Server } from "teleportal/server";
import { getHTTPEndpoint, getSSEHandler } from "./handlers";

/**
 * Callback function type that takes a request and returns a list of document names to subscribe to
 */
export type DocumentSubscriptionCallback = (request: Request) => string[];

/**
 * Default implementation that extracts document IDs from URL query parameters
 * Supports multiple 'documents' parameters: ?documents=id-1&documents=id-2
 * Also supports comma-separated values: ?documents=id-1,id-2
 */
export function getDocumentsFromQueryParams(request: Request): string[] {
  const url = new URL(request.url);
  const documentParams = url.searchParams.getAll('documents');
  
  const documentIds: string[] = [];
  
  for (const param of documentParams) {
    // Handle both single IDs and comma-separated lists
    const ids = param.split(',').map(id => id.trim()).filter(id => id.length > 0);
    documentIds.push(...ids);
  }
  
  // Remove duplicates and return
  return [...new Set(documentIds)];
}

export function getHandlers<Context extends ServerContext>({
  server,
  getDocumentsToSubscribe = getDocumentsFromQueryParams,
}: {
  server: Server<Context>;
  getDocumentsToSubscribe?: DocumentSubscriptionCallback;
}): (req: Request) => Response | Promise<Response> {
  const sseEndpoint = getSSEHandler({
    server,
    validateRequest: async (req) => {
      return { 
        userId: "test", 
        room: "test",
      } as Context;
    },
    getDocumentsToSubscribe,
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
      return await sseEndpoint(req);
    }

    if (req.method === "POST" && url.pathname === "/message") {
      return await httpEndpoint(req);
    }

    return new Response("Not Found", { status: 404 });
  };
}
