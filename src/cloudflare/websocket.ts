import type * as crossws from "crossws";

import type { ServerContext } from "teleportal";
import { getWebsocketHandlers } from "teleportal/websocket-server";

/**
 * {@link getWebsocketHandlers} wrapped for crossws's Cloudflare Durable
 * Object adapter.
 *
 * The durable upgrade path (`handleDurableUpgrade`) discards the `context`
 * returned by the upgrade hook, so the peer would reach `open` without the
 * userId/room resolved by `onUpgrade`. The same `Request` object flows from
 * the upgrade hook into the peer, so the context is stashed per-request here
 * and re-applied to `peer.context` before the regular `open` logic runs —
 * without re-running authentication.
 */
export function getDurableObjectWebsocketHooks<T extends ServerContext>(
  options: Parameters<typeof getWebsocketHandlers<T>>[0],
): crossws.Hooks {
  const hooks = getWebsocketHandlers<T>(options);
  const contexts = new WeakMap<object, object>();

  return {
    ...hooks,
    async upgrade(request) {
      const result = await hooks.upgrade!(request as Parameters<typeof hooks.upgrade>[0]);
      if (result && "context" in result && result.context) {
        contexts.set(request as object, result.context);
      }
      return result;
    },
    async open(peer) {
      const context = contexts.get(peer.request as object);
      if (context) {
        Object.assign(peer.context, context);
      }
      return hooks.open!(peer);
    },
  };
}
