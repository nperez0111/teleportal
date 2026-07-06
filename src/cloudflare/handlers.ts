/**
 * The methods of crossws's Cloudflare Durable Object adapter that a
 * Teleportal Durable Object delegates to. Structural so this package never
 * imports `crossws/adapters/cloudflare` itself — that module imports
 * `cloudflare:workers` at module scope, which only resolves inside workerd.
 * The consumer instantiates the adapter and passes it in.
 */
export interface CrosswsDurableAdapterLike {
  handleDurableUpgrade(obj: object, req: Request): Promise<Response>;
  handleDurableMessage(obj: object, ws: unknown, message: ArrayBuffer | string): Promise<void>;
  handleDurableClose(
    obj: object,
    ws: unknown,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void>;
  handleDurablePublish(obj: object, topic: string, data: unknown, opts?: unknown): Promise<void>;
}

/**
 * Bundle the crossws adapter and Teleportal's HTTP handler into the method
 * bodies of a Durable Object class. The class delegates, passing itself:
 *
 * ```ts
 * import crossws from "crossws/adapters/cloudflare";
 *
 * class TeleportalDurableObject {
 *   ctx; #handlers;
 *   constructor(state, env) {
 *     this.ctx = state;
 *     const server = new Server({ ... });
 *     this.#handlers = getDurableObjectHandlers({
 *       ws: crossws({ hooks: getDurableObjectWebsocketHooks({ server, onUpgrade }) }),
 *       http: getHTTPHandlers({ server, getContext }),
 *     });
 *   }
 *   fetch(request) { return this.#handlers.fetch(this, request); }
 *   webSocketMessage(ws, message) { return this.#handlers.webSocketMessage(this, ws, message); }
 *   webSocketClose(ws, code, reason, wasClean) {
 *     return this.#handlers.webSocketClose(this, ws, code, reason, wasClean);
 *   }
 *   webSocketPublish(topic, data, opts) {
 *     return this.#handlers.webSocketPublish(this, topic, data, opts);
 *   }
 * }
 * ```
 */
export function getDurableObjectHandlers({
  ws,
  http,
}: {
  /** The instantiated `crossws/adapters/cloudflare` adapter. */
  ws: CrosswsDurableAdapterLike;
  /** Teleportal's HTTP handler (e.g. from `getHTTPHandlers`). */
  http: (request: Request) => Response | Promise<Response>;
}) {
  return {
    fetch(obj: object, request: Request): Response | Promise<Response> {
      if (request.headers.get("upgrade") === "websocket") {
        return ws.handleDurableUpgrade(obj, request);
      }
      return http(request);
    },
    webSocketMessage(obj: object, socket: unknown, message: ArrayBuffer | string): Promise<void> {
      return ws.handleDurableMessage(obj, socket, message);
    },
    webSocketClose(
      obj: object,
      socket: unknown,
      code: number,
      reason: string,
      wasClean: boolean,
    ): Promise<void> {
      return ws.handleDurableClose(obj, socket, code, reason, wasClean);
    },
    webSocketPublish(obj: object, topic: string, data: unknown, opts?: unknown): Promise<void> {
      return ws.handleDurablePublish(obj, topic, data, opts);
    },
  };
}
