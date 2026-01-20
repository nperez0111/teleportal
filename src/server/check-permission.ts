import type { ServerOptions } from "./server";
import type { TokenManager, TokenPayload } from "teleportal/token";

export function checkPermissionWithTokenManager(
  tokenManager: TokenManager,
): ServerOptions<any>["checkPermission"] {
  return async ({ context, documentId, message }) => {
    // ACK messages don't require permission checks - they're acknowledgments
    if (message.type === "ack") {
      return true;
    }

    // Awareness messages don't require permission checks - they're presence updates
    if (message.type === "awareness") {
      return true;
    }

    // RPC messages - permission checks are handled by the RPC handlers themselves
    // based on the method being called
    if (message.type === "rpc") {
      return true;
    }

    if (message.type === "doc") {
      if (!documentId) {
        throw new Error("documentId is required for doc messages");
      }

      // Extract token payload from context
      // The context should contain the token payload fields (userId, room, documentAccess)
      // when using token authentication
      const tokenPayload = context as unknown as TokenPayload;

      switch (message.payload.type) {
        case "sync-done":
        case "sync-step-1": {
          return tokenManager.hasDocumentPermission(
            tokenPayload,
            documentId,
            "read",
          );
        }
        case "sync-step-2":
        case "update": {
          return tokenManager.hasDocumentPermission(
            tokenPayload,
            documentId,
            "write",
          );
        }
        case "auth-message": {
          // Auth messages are responses from the server, not requests from clients
          // They should not be broadcasted, so deny them
          return false;
        }
        default: {
          throw new Error(
            `Unknown doc message payload type: ${(message.payload as any).type}`,
          );
        }
      }
    }

    // Allow all other message types through (shouldn't happen, but be permissive)
    return true;
  };
}
