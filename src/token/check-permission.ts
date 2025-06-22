import type { ServerOptions } from "match-maker/server";
import type { TokenManager } from ".";

export function checkPermissionWithTokenManager(
  tokenManager: TokenManager,
): ServerOptions<any>["checkPermission"] {
  return async ({ context, document, message }) => {
    if (message.type === "doc") {
      switch (message.payload.type) {
        case "sync-step-1":
          return tokenManager.hasDocumentPermission(context, document, "read");
        case "sync-step-2":
        case "update":
          return tokenManager.hasDocumentPermission(context, document, "write");
        default:
          throw new Error(
            `Unknown message type: ${(message.payload as any).type}`,
          );
      }
    }

    // we just allow all other message types through for now
    return true;
  };
}
