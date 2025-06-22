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
        case "auth-message":
          // TODO what should we do here?
          console.log("Got an auth message, denying it?");
          // We shouldn't really be getting auth messages here, so we'll just deny them from being broadcasted
          return false;
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
