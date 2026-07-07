export { TeleportalDurableObject } from "./durable-object";

/**
 * Structural types for the Durable Object binding so the example does not
 * need `@cloudflare/workers-types` ambient globals (they conflict with
 * `@types/bun` in this repo's typecheck).
 */
interface Env {
  TELEPORTAL_DO: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  };
}

/**
 * All sync traffic lives under `/api/*`: static assets handle everything
 * else, and a WebSocket upgrade is a `GET /` that would otherwise be
 * swallowed by the asset for `/`. The whole app runs in ONE Durable Object
 * instance so WebSocket and SSE/HTTP clients share the same Teleportal
 * Server and sessions. To shard by room instead, derive the instance name
 * from the request (e.g. `idFromName(room)`).
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/api" && !url.pathname.startsWith("/api/")) {
      return new Response("Not Found", { status: 404 });
    }
    url.pathname = url.pathname.slice("/api".length) || "/";

    const stub = env.TELEPORTAL_DO.get(env.TELEPORTAL_DO.idFromName("teleportal"));
    // Re-target the request at the stripped path; WebSocket upgrades pass
    // through stub.fetch unchanged.
    return stub.fetch(new Request(url, request));
  },
};
