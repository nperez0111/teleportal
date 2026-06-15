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

export interface AttributionRpcOptions {
  /**
   * Optional gate for attribution reads. RPC messages bypass the server's
   * global permission check, so attribution-specific authorization lives here.
   * Return false (or throw) to deny. When omitted, reads are allowed for any
   * client with an open session for the document (milestone parity).
   */
  checkPermission?: (context: RpcServerContext) => boolean | Promise<boolean>;
}

const FORBIDDEN: RpcError = {
  type: "error",
  statusCode: 403,
  details: "Attribution access denied",
};

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
    return true;
  };
}

const activityHandler =
  (options: AttributionRpcOptions) =>
  async (
    payload: AttributionActivityRequest,
    context: RpcServerContext,
  ): Promise<{ response: AttributionActivityResponse | RpcError }> => {
    try {
      if (options.checkPermission && !(await options.checkPermission(context))) {
        return { response: FORBIDDEN };
      }
      const encoded = await loadContentMap(context);
      if (!encoded) return { response: { activity: [] } };

      const activity = getActivity(decodeContentMap(encoded), {
        from: payload.from,
        to: payload.to,
        userId: payload.userId,
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

const getHandler =
  (options: AttributionRpcOptions) =>
  async (
    payload: AttributionGetRequest,
    context: RpcServerContext,
  ): Promise<{ response: AttributionGetResponse | RpcError }> => {
    try {
      if (options.checkPermission && !(await options.checkPermission(context))) {
        return { response: FORBIDDEN };
      }
      const encoded = await loadContentMap(context);
      if (!encoded) return { response: { contentMap: null } };

      const filter = payload.filter;
      if (
        filter &&
        (filter.userId !== undefined || filter.from !== undefined || filter.to !== undefined)
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
export function getAttributionRpcHandlers(options: AttributionRpcOptions = {}): RpcHandlerRegistry {
  return {
    ["attributionActivity"]: {
      handler: activityHandler(options),
    } as RpcServerRequestHandler<unknown, unknown, unknown, RpcServerContext>,
    ["attributionGet"]: {
      handler: getHandler(options),
    } as RpcServerRequestHandler<unknown, unknown, unknown, RpcServerContext>,
  };
}
