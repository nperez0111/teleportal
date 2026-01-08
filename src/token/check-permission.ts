import type { ServerOptions } from "teleportal/server";
import type { TokenManager } from ".";

export function checkPermissionWithTokenManager(
  tokenManager: TokenManager,
): ServerOptions<any>["checkPermission"] {
  return async ({ context, documentId, fileId, message }) => {
    if (message.type === "doc") {
      if (!documentId) {
        throw new Error("documentId is required for doc messages");
      }
      switch (message.payload.type) {
        case "sync-done":
        case "sync-step-1":
        case "milestone-list-request":
        case "milestone-snapshot-response":
        case "milestone-snapshot-request":
        case "milestone-list-response":
        case "milestone-update-name-response":
        case "milestone-create-response":
          return tokenManager.hasDocumentPermission(
            context,
            documentId,
            "read",
          );
        case "sync-step-2":
        case "update":
        case "milestone-create-request":
        case "milestone-update-name-request":
          return tokenManager.hasDocumentPermission(
            context,
            documentId,
            "write",
          );
        case "auth-message":
        case "milestone-auth-message":
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

    if (message.type === "file") {
      // File messages use fileId instead of documentId
      // For now, we allow all file messages through
      // In the future, you could implement file-specific permission checks here
      return true;
    }

    // we just allow all other message types through for now
    return true;
  };
}
