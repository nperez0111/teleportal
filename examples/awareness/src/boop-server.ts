import { createHandlers, ok, type RpcHandlerRegistry } from "teleportal/rpc";
import { RpcMessage } from "teleportal/protocol";
import { boopProtocol } from "./boop-protocol";

export function getBoopRpcHandlers(): RpcHandlerRegistry {
  return createHandlers(
    boopProtocol,
    {},
    {
      send: () => async (payload, ctx) => {
        ctx.session.broadcast(
          new RpcMessage(
            ctx.session.documentId,
            {
              type: "success",
              payload: {
                targetAwarenessId: payload.targetAwarenessId,
                fromAwarenessId: payload.fromAwarenessId,
              },
            },
            "booped",
            "request",
            undefined,
            {},
            false,
          ) as any,
        );
        return ok({ success: true });
      },
    },
  );
}
