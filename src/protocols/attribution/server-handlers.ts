import {
  type RpcError,
  type RpcHandlerRegistry,
  type RpcServerContext,
  type RpcServerRequestHandler,
} from "teleportal/protocol";
import {
  type ContentAttribute,
  decodeContentMap,
  encodeContentMap,
  filterContentMap,
  getActivity,
} from "teleportal/attribution";
import type { EncodedContentMap } from "teleportal/storage";
import {
  type AttributionActivityRequest,
  type AttributionActivityResponse,
  type AttributionFilter,
  type AttributionGetRequest,
  type AttributionGetResponse,
} from "./methods";

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
        if (!attr || attr.val !== val) return false;
      }
    }
    return true;
  };
}

const activityHandler = async (
  payload: AttributionActivityRequest,
  context: RpcServerContext,
): Promise<{ response: AttributionActivityResponse | RpcError }> => {
  try {
    const encoded = await loadContentMap(context);
    if (!encoded) return { response: { activity: [] } };

    const activity = getActivity(decodeContentMap(encoded), {
      from: payload.from,
      to: payload.to,
      userId: payload.userId,
      attributes: payload.attributes,
    });
    return { response: { activity } };
  } catch (error) {
    return {
      response: {
        type: "error",
        statusCode: 500,
        details: error instanceof Error ? error.message : "Failed to read attribution activity",
      },
    };
  }
};

const getHandler = async (
  payload: AttributionGetRequest,
  context: RpcServerContext,
): Promise<{ response: AttributionGetResponse | RpcError }> => {
  try {
    const encoded = await loadContentMap(context);
    if (!encoded) return { response: { contentMap: null } };

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
      return { response: { contentMap: encodeContentMap(filtered) } };
    }

    return { response: { contentMap: encoded } };
  } catch (error) {
    return {
      response: {
        type: "error",
        statusCode: 500,
        details: error instanceof Error ? error.message : "Failed to read attribution",
      },
    };
  }
};

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
  return {
    ["attributionActivity"]: {
      handler: activityHandler,
    } as RpcServerRequestHandler<unknown, unknown, unknown, RpcServerContext>,
    ["attributionGet"]: {
      handler: getHandler,
    } as RpcServerRequestHandler<unknown, unknown, unknown, RpcServerContext>,
  };
}
