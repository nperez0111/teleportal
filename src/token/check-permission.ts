import type { ServerOptions } from "teleportal/server";
import type { TokenManager, TokenPayload } from ".";

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
        case "sync-step-1":
        case "milestone-list-request":
        case "milestone-snapshot-response":
        case "milestone-snapshot-request":
        case "milestone-list-response":
        case "milestone-update-name-response":
        case "milestone-create-response":
          return tokenManager.hasDocumentPermission(
            tokenPayload,
            documentId,
            "read",
          );
        case "sync-step-2":
        case "update":
        case "milestone-create-request":
        case "milestone-update-name-request":
          return tokenManager.hasDocumentPermission(
            tokenPayload,
            documentId,
            "write",
          );
        case "auth-message":
        case "milestone-auth-message":
          // Auth messages are responses from the server, not requests from clients
          // They should not be broadcasted, so deny them
          return false;
        default:
          throw new Error(
            `Unknown doc message payload type: ${(message.payload as any).type}`,
          );
      }
    }

    if (message.type === "file") {
      // File messages use fileId instead of documentId
      // For now, we allow all file messages through
      // In the future, you could implement file-specific permission checks here
      // Note: file-auth-message is already filtered out by the server before this is called
      return true;
    }

    // Allow all other message types through (shouldn't happen, but be permissive)
    return true;
  };
}
