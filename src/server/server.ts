import { uuidv4 } from "lib0/random";
import {
  DocMessage,
  FileMessage,
  InMemoryPubSub,
  type Message,
  type PubSub,
  type ServerContext,
} from "teleportal";
import type { DocumentStorage } from "teleportal/storage";
import { withMessageValidator } from "teleportal/transports";
import { toErrorDetails } from "../logging";
import { getLogger } from "@logtape/logtape";
import { Session } from "./session";
import { Client } from "./client";
import { FileHandler } from "./file-handler";

export type ServerOptions<Context extends ServerContext> = {
  /**
   * Retrieve per-document storage.
   */
  getStorage: (ctx: {
    documentId: string;
    context: Context;
    encrypted: boolean;
  }) => Promise<DocumentStorage>;

  /**
   * Optional permission checker for read/write.
   * Either documentId or fileId will be provided, but not both.
   */
  checkPermission?: (ctx: {
    context: Context;
    documentId?: string;
    fileId?: string;
    message: Message<Context>;
    type: "read" | "write";
  }) => Promise<boolean>;

  /**
   * PubSub backend for cross-node fanout. Defaults to in-memory.
   */
  pubSub?: PubSub;

  /**
   * Node ID for this server instance. Used to filter out messages from the same node.
   * Defaults to a random UUID.
   */
  nodeId?: string;
};

export class Server<Context extends ServerContext> {
  /**
   * The options for the server.
   */
  #options: ServerOptions<Context>;
  /**
   * The pubSub for the server.
   */
  readonly pubSub: PubSub;
  /**
   * The node ID for the server.
   */
  #nodeId: string;
  /**
   * The active sessions for the server.
   */
  #sessions = new Map<string, Session<Context>>();
  /**
   * Pending session creation promises to prevent race conditions.
   * Maps composite document ID to the promise that will resolve to the session.
   */
  #pendingSessions = new Map<string, Promise<Session<Context>>>();

  constructor(options: ServerOptions<Context>) {
    this.#options = options;
    const logger = getLogger(["teleportal", "server"]);

    this.pubSub = options.pubSub ?? new InMemoryPubSub();
    this.#nodeId = options.nodeId ?? `node-${uuidv4()}`;

    logger.info("Server initialized", {
      nodeId: this.#nodeId,
      hasCustomPubSub: !!options.pubSub,
      hasPermissionChecker: !!options.checkPermission,
    });
  }

  /**
   * Create a composite document ID from room and document name.
   * If room is provided, returns `${room}/${document}`, otherwise returns `document`.
   */
  #getCompositeDocumentId(document: string, context?: Context): string {
    if (context && "room" in context && context.room) {
      return `${context.room}/${document}`;
    }
    return document;
  }

  /**
   * Create or get a session for a document.
   * @param documentId - The ID of the document.
   * @param encrypted - Whether the document is encrypted.
   * @param id - The ID of the session.
   * @param context - Optional context containing room information for multi-tenancy.
   * @returns The session.
   */
  async getOrOpenSession(
    documentId: string | undefined,
    {
      encrypted,
      id = "session-" + uuidv4(),
      client,
      context,
    }: {
      encrypted: boolean;
      id?: string;
      client?: Client<Context>;
      context: Context;
    },
  ) {
    if (!documentId) {
      throw new Error("Document ID is required");
    }

    const logger = getLogger(["teleportal", "server"]);
    const compositeDocumentId = this.#getCompositeDocumentId(
      documentId,
      context,
    );

    // Check if session already exists
    const existing = this.#sessions.get(compositeDocumentId);
    if (existing) {
      // Validate that the encryption state matches the existing session
      if (existing.encrypted !== encrypted) {
        const error = new Error(
          `Encryption state mismatch: existing session for document "${compositeDocumentId}" has encrypted=${existing.encrypted}, but requested encrypted=${encrypted}`,
        );
        logger.error("Encryption state mismatch detected", {
          documentId: compositeDocumentId,
          sessionId: existing.id,
          existingEncrypted: existing.encrypted,
          requestedEncrypted: encrypted,
          error: toErrorDetails(error),
        });
        throw error;
      }

      logger.debug("Retrieved existing session", {
        documentId: compositeDocumentId,
        sessionId: existing.id,
        encrypted,
      });

      if (client) {
        existing.addClient(client);
      }

      return existing;
    }

    // Check if there's a pending session creation for this document
    const pending = this.#pendingSessions.get(compositeDocumentId);
    if (pending) {
      logger.debug("Waiting for pending session creation", {
        documentId: compositeDocumentId,
      });

      const session = await pending;

      // Validate encryption state matches
      if (session.encrypted !== encrypted) {
        const error = new Error(
          `Encryption state mismatch: pending session for document "${compositeDocumentId}" has encrypted=${session.encrypted}, but requested encrypted=${encrypted}`,
        );
        logger.error("Encryption state mismatch detected", {
          documentId: compositeDocumentId,
          sessionId: session.id,
          existingEncrypted: session.encrypted,
          requestedEncrypted: encrypted,
          error: toErrorDetails(error),
        });
        throw error;
      }

      if (client) {
        session.addClient(client);
      }

      return session;
    }

    // Create a new session - wrap in a promise to prevent race conditions
    const sessionLogger = logger.with({
      documentId: compositeDocumentId,
      sessionId: id,
      encrypted,
    });

    sessionLogger.info("Creating new session", {
      documentId: compositeDocumentId,
      sessionId: id,
      encrypted,
    });

    const sessionPromise = (async (): Promise<Session<Context>> => {
      try {
        const storage = await this.#options.getStorage({
          documentId: compositeDocumentId,
          context,
          encrypted,
        });

        sessionLogger.debug("Storage retrieved for session");

        const session = new Session<Context>({
          documentId,
          namespacedDocumentId: compositeDocumentId,
          id,
          encrypted,
          storage,
          pubSub: this.pubSub,
          nodeId: this.#nodeId,
          onCleanupScheduled: this.#handleSessionCleanup.bind(this),
        });

        await session.load();
        this.#sessions.set(compositeDocumentId, session);

        sessionLogger
          .with({
            documentId: compositeDocumentId,
            sessionId: id,
            encrypted,
            totalSessions: this.#sessions.size,
          })
          .info("Session created and loaded");

        return session;
      } catch (error) {
        sessionLogger
          .with({
            error: toErrorDetails(error as Error),
            documentId: compositeDocumentId,
            sessionId: id,
            encrypted,
          })
          .error("Failed to create session");
        throw error;
      } finally {
        // Always remove from pending map, even on error
        this.#pendingSessions.delete(compositeDocumentId);
      }
    })();

    // Store the promise so concurrent calls can wait for it
    this.#pendingSessions.set(compositeDocumentId, sessionPromise);

    const session = await sessionPromise;

    if (client) {
      session.addClient(client);
    }

    return session;
  }

  /**
   * Deletes a document and its associated data (files, sessions, etc.).
   * @param documentId - The ID of the document to delete.
   * @param context - Optional context for document ID resolution.
   */
  async deleteDocument(
    documentId: string,
    context: Context,
    encrypted: boolean,
  ): Promise<void> {
    const logger = getLogger(["teleportal", "server"]);
    const compositeDocumentId = this.#getCompositeDocumentId(
      documentId,
      context,
    );

    logger
      .with({
        documentId: compositeDocumentId,
        encrypted,
      })
      .info("Deleting document");

    // Get storage directly to delete document data
    const storage = await this.#options.getStorage({
      documentId: compositeDocumentId,
      context,
      encrypted,
    });

    // Close existing session if any
    const session = this.#sessions.get(compositeDocumentId);
    if (session) {
      // Disconnect all clients
      for (const client of session.clients) {
        // Optionally notify clients about deletion
        // await client.send(new DocMessage(documentId, { type: "deleted" }, context, encrypted));
      }
      await session[Symbol.asyncDispose]();
      this.#sessions.delete(compositeDocumentId);
    }

    // Wait for any pending session creation
    const pending = this.#pendingSessions.get(compositeDocumentId);
    if (pending) {
      try {
        const pendingSession = await pending;
        await pendingSession[Symbol.asyncDispose]();
      } catch (e) {
        // Ignore errors from pending session
      }
      this.#pendingSessions.delete(compositeDocumentId);
    }

    // Delete document data via storage (this handles cascade deletion of files)
    await storage.deleteDocument(compositeDocumentId);

    logger
      .with({
        documentId: compositeDocumentId,
      })
      .info("Document deleted");
  }

  /**
   * Create a client for a transport.
   * @param ctx - Context Object
   * @param ctx.transport - The transport to use for the client.
   * @param id - The ID of the client.
   * @param abortSignal - When the signal is aborted, the client will be removed from the server
   * @returns The client.
   */
  createClient({
    transport,
    id = "client-" + uuidv4(),
    abortSignal,
  }: {
    transport: import("teleportal").Transport<Context>;
    id?: string;
    abortSignal?: AbortSignal;
  }) {
    const logger = getLogger(["teleportal", "server"]).with({ clientId: id });

    logger.info("Creating new client");

    const client = new Client<Context>({
      id,
      writable: transport.writable,
    });

    withMessageValidator(transport, {
      isAuthorized: async (message, type) => {
        if (!this.#options.checkPermission) {
          logger
            .with({
              messageId: message.id,
              documentId: message.document,
              messageType: message.type,
              permissionType: type,
            })
            .debug("No permission checker configured, allowing message");
          return true;
        }

        const msgLogger = logger.with({ messageId: message.id });

        // Skip permission check for file-auth-message (they're responses, not requests)
        if (
          message.type === "file" &&
          message.payload.type === "file-auth-message"
        ) {
          // Just ignore this message that's sent by the client
          return false;
        }

        // Extract fileId from FileMessage payload if document is undefined
        const fileId =
          message.type === "file" &&
          (message.payload.type === "file-download" ||
            message.payload.type === "file-upload" ||
            message.payload.type === "file-part")
            ? message.payload.fileId
            : undefined;

        msgLogger
          .with({
            messageId: message.id,
            documentId: message.document,
            fileId,
            messageType: message.type,
            permissionType: type,
            userId: message.context.userId,
            clientId: message.context.clientId,
          })
          .debug("Checking permission");

        try {
          // Ensure at least one of documentId or fileId is provided
          if (!message.document && !fileId) {
            throw new Error(
              `Message ${message.id} must have either documentId or fileId`,
            );
          }

          const ok = await this.#options.checkPermission({
            context: message.context,
            documentId: message.document ?? undefined,
            fileId,
            message,
            type,
          });

          msgLogger
            .with({
              messageId: message.id,
              documentId: message.document,
              fileId,
              permissionType: type,
              authorized: ok,
            })
            .trace(ok ? "Message authorized" : "Message denied");

          if (!ok) {
            if (
              message.type === "doc" &&
              message.payload.type === "sync-step-2"
            ) {
              msgLogger.debug(
                "Client tried to send sync-step-2 message but doesn't have write permissions, dropping message",
              );
              // Tell the client that they've successfully synced their state vector
              await client.send(
                new DocMessage(
                  message.document,
                  { type: "sync-done" },
                  message.context,
                  message.encrypted,
                ),
              );
              return false;
            }

            if (message.type === "file") {
              await client.send(
                new FileMessage(
                  message.document,
                  {
                    type: "file-auth-message",
                    permission: "denied",
                    reason: "Insufficient permissions to access file",
                    statusCode: 401,
                    fileId: fileId!,
                  },
                  message.context,
                  message.encrypted,
                ),
              );
              return false;
            }

            if (!message.document) {
              // just ignore this message (it's an ack message)
              return false;
            }

            // Otherwise, send a doc-auth-message
            await client.send(
              new DocMessage(
                message.document,
                {
                  type: "auth-message",
                  permission: "denied",
                  reason: `Insufficient permissions to access document ${message.document}`,
                },
                message.context,
                message.encrypted,
              ),
            );
            return false;
          }
          return true;
        } catch (error) {
          msgLogger
            .with({
              error: toErrorDetails(error as Error),
              messageId: message.id,
              documentId: message.document,
              permissionType: type,
            })
            .error("Permission check failed");
          return false;
        }
      },
    })
      .readable.pipeTo(
        new WritableStream<Message<Context>>({
          write: async (message) => {
            const msgLogger = logger.with({
              messageId: message.id,
              documentId: message.document,
            });

            msgLogger
              .with({
                messageId: message.id,
                documentId: message.document,
                messageType: message.type,
                encrypted: message.encrypted,
                payloadType: (message as any).payload?.type,
              })
              .debug("Processing incoming message");

            try {
              // File messages need a session to access storage
              if (message.type === "file") {
                const session = await this.getOrOpenSession(message.document, {
                  encrypted: message.encrypted,
                  client,
                  context: message.context,
                });

                // Check if file storage is available for this document
                // We need to access the storage implementation to check for fileStorage
                // @ts-ignore - we know the storage has fileStorage if it supports files
                const fileStorage = session.storage.fileStorage;

                if (!fileStorage) {
                  const error = new Error(
                    "File storage not configured. File messages are not supported.",
                  );
                  msgLogger
                    .with({ error: toErrorDetails(error) })
                    .error("File storage not available");

                  // Send error response
                  if (
                    message.payload.type === "file-upload" ||
                    message.payload.type === "file-download"
                  ) {
                    await client.send(
                      new FileMessage(
                        message.document,
                        {
                          type: "file-auth-message",
                          permission: "denied",
                          reason: "File storage not configured",
                          statusCode: 501,
                          fileId: message.payload.fileId,
                        },
                        message.context,
                        message.encrypted,
                      ),
                    );
                  }

                  return; // Don't throw, just return
                }

                msgLogger.debug("Processing file message");

                // Create a temporary handler for this message using the session's file storage
                const fileHandler = new FileHandler<Context>(fileStorage);

                await fileHandler.handle(message, async (response) => {
                  await client.send(response);
                });

                msgLogger
                  .with({
                    messageId: message.id,
                  })
                  .debug("File message processed successfully");
              } else {
                // Document messages go through sessions
                const session = await this.getOrOpenSession(message.document, {
                  encrypted: message.encrypted,
                  client,
                  context: message.context,
                });

                msgLogger.debug("Client added to session, applying message");

                await session.apply(message, client);

                msgLogger
                  .with({
                    messageId: message.id,
                    documentId: message.document,
                  })
                  .debug("Message applied successfully");
              }
            } catch (error) {
              msgLogger
                .with({
                  error: toErrorDetails(error as Error),
                  messageId: message.id,
                  documentId: message.document,
                  messageType: message.type,
                })
                .error("Failed to process message");
              throw error;
            }
          },
        }),
      )
      .catch((e) => {
        logger
          .with({ error: toErrorDetails(e), clientId: id })
          .error("Client stream errored");
      })
      .finally(() => {
        logger
          .with({ clientId: id })
          .info("Client stream ended, disconnecting client");
        this.disconnectClient(client.id);
      });

    logger.with({ clientId: id }).info("Client created and connected");

    if (abortSignal) {
      abortSignal.addEventListener("abort", () => {
        this.disconnectClient(client.id);
      });
    }

    return client;
  }

  /**
   * Disconnect a client from all sessions.
   * @param client - The client or client ID to disconnect.
   */
  disconnectClient(client: string | Client<Context>) {
    const clientId = typeof client === "string" ? client : client.id;
    const logger = getLogger(["teleportal", "server"]).with({ clientId });

    logger.with({ clientId }).info("Disconnecting client from all sessions");

    for (const s of this.#sessions.values()) {
      s.removeClient(client);
    }

    logger
      .with({
        clientId,
        totalSessions: this.#sessions.size,
      })
      .info("Client disconnected from sessions");
  }

  /**
   * Handle cleanup of a session that was scheduled for disposal.
   */
  #handleSessionCleanup(session: Session<Context>) {
    const logger = getLogger(["teleportal", "server"]);
    // Check if session still exists in our map (using namespacedDocumentId as key)
    const existingSession = this.#sessions.get(session.namespacedDocumentId);
    if (!existingSession || existingSession !== session) {
      // Session was already removed or replaced
      return;
    }

    // Verify session should still be disposed (has no clients)
    if (session.shouldDispose) {
      logger
        .with({
          documentId: session.documentId,
          namespacedDocumentId: session.namespacedDocumentId,
          sessionId: session.id,
        })
        .info("Cleaning up session with no clients");

      this.#sessions.delete(session.namespacedDocumentId);
      session[Symbol.asyncDispose]().catch((error) => {
        logger
          .with({
            error: toErrorDetails(error as Error),
            documentId: session.documentId,
            namespacedDocumentId: session.namespacedDocumentId,
            sessionId: session.id,
          })
          .error("Error disposing session during cleanup");
      });
    }
  }

  /**
   * Async dispose the server.
   */
  async [Symbol.asyncDispose](): Promise<void> {
    const logger = getLogger(["teleportal", "server"]);
    logger
      .with({
        nodeId: this.#nodeId,
        activeSessions: this.#sessions.size,
        pendingSessions: this.#pendingSessions.size,
      })
      .info("Disposing server");

    // Wait for any pending session creations to complete (or fail)
    // This prevents dangling promises and ensures we don't dispose while sessions are being created
    if (this.#pendingSessions.size > 0) {
      logger
        .with({
          pendingCount: this.#pendingSessions.size,
        })
        .debug("Waiting for pending session creations to complete");

      await Promise.allSettled(
        Array.from(this.#pendingSessions.values()).map(async (promise) => {
          try {
            await promise;
          } catch (error) {
            // Ignore errors from pending session creation - they're expected if creation fails
          }
        }),
      );

      this.#pendingSessions.clear();
    }

    for (const s of this.#sessions.values()) {
      try {
        await s[Symbol.asyncDispose]();
      } catch (error) {
        logger
          .with({
            error: toErrorDetails(error as Error),
            sessionId: s.id,
            documentId: s.documentId,
          })
          .error("Error disposing session");
      }
    }

    try {
      await this.pubSub[Symbol.asyncDispose]?.();
    } catch (error) {
      logger
        .with({ error: toErrorDetails(error as Error) })
        .error("Error disposing pubSub");
    }

    logger
      .with({
        nodeId: this.#nodeId,
      })
      .info("Server disposed");
  }

  toString() {
    return `Server(nodeId: ${this.#nodeId}, activeSessions: ${this.#sessions
      .values()
      .map((s) => s.toString())
      .toArray()
      .join(", ")})`;
  }

  toJSON() {
    return {
      nodeId: this.#nodeId,
      activeSessions: this.#sessions
        .values()
        .map((s) => s.toJSON())
        .toArray(),
    };
  }
}
