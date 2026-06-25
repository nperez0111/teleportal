import { equalityDeep } from "lib0/function";
import { createHandlers, ok, type RpcHandlerRegistry, type RpcServerContext } from "teleportal/rpc";
import {
  type ContentAttribute,
  decodeContentMap,
  encodeContentMap,
  filterContentMap,
  getActivity,
} from "teleportal/attribution";
import type { EncodedContentMap } from "teleportal/storage";
import { attributionProtocol, type AttributionFilter } from "./methods";

async function loadContentMap(context: RpcServerContext): Promise<EncodedContentMap | null> {
  const retrieve = context.session.storage.retrieveAttribution;
  if (!retrieve) return null;
  return retrieve.call(context.session.storage, context.documentId);
}

/**
 * Build a ContentMap attribute predicate from an {@link AttributionFilter}.
 * Insert ranges carry `insert`/`insertAt`, delete ranges `delete`/`deleteAt`.
 */
function matchesFilter(filter: AttributionFilter): (attrs: ContentAttribute[]) => boolean {
  return (attrs) => {
    if (filter.userId !== undefined) {
      const userAttr = attrs.find((a) => a.name === "insert" || a.name === "delete");
      if (!userAttr || userAttr.val !== filter.userId) return false;
    }
    if (filter.from !== undefined || filter.to !== undefined) {
      const timeAttr = attrs.find((a) => a.name === "insertAt" || a.name === "deleteAt");
      if (timeAttr) {
        const t = timeAttr.val as number;
        if (filter.from !== undefined && t < filter.from) return false;
        if (filter.to !== undefined && t > filter.to) return false;
      }
    }
    if (filter.attributes) {
      for (const [name, val] of Object.entries(filter.attributes)) {
        const attr = attrs.find((a) => a.name === name);
        if (!attr || !equalityDeep(attr.val, val)) return false;
      }
    }
    return true;
  };
}

/**
 * Creates read-only RPC handlers that expose document attribution to clients.
 *
 * Register alongside other protocol handlers:
 *
 *   new Server({ rpcHandlers: { ...getAttributionRpcHandlers() } })
 *
 * Methods:
 * - `attributionActivity` — activity timeline (works for encrypted documents).
 * - `attributionGet` — the encoded ContentMap for client-side range resolution.
 */
export function getAttributionRpcHandlers(): RpcHandlerRegistry {
  return createHandlers(
    attributionProtocol,
    {},
    {
      activity: () => async (payload, context) => {
        const encoded = await loadContentMap(context);
        if (!encoded) return ok({ activity: [] });

        const activity = getActivity(decodeContentMap(encoded), {
          from: payload.from,
          to: payload.to,
          userId: payload.userId,
          attributes: payload.attributes,
        });
        return ok({ activity });
      },

      get: () => async (payload, context) => {
        const encoded = await loadContentMap(context);
        if (!encoded) return ok({ contentMap: null });

        const filter = payload.filter;
        if (
          filter &&
          (filter.userId !== undefined ||
            filter.from !== undefined ||
            filter.to !== undefined ||
            (filter.attributes && Object.keys(filter.attributes).length > 0))
        ) {
          const predicate = matchesFilter(filter);
          const filtered = filterContentMap(decodeContentMap(encoded), predicate);
          return ok({ contentMap: encodeContentMap(filtered) });
        }

        return ok({ contentMap: encoded });
      },
    },
  );
}
