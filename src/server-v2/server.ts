import { uuidv4 } from "lib0/random";
import {
  DocMessage,
  InMemoryPubSub,
  type Message,
  type PubSub,
  type ServerContext,
} from "teleportal";
import type { DocumentStorage } from "teleportal/storage";
import { withMessageValidator } from "teleportal/transports";
import { logger as defaultLogger, type Logger } from "./logger";
import { Session as DocumentSession } from "./session";
import { Client } from "./client";

export type ServerOptions<Context extends ServerContext> = {
  logger?: Logger;
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
   */
  checkPermission?: (ctx: {
    context: Context;
    documentId: string;
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
   * The logger for the server.
   */
  readonly logger: Logger;
  /**
   * The options for the server.
   */
  #options: ServerOptions<Context>;
  /**
   * The pubsub for the server.
   */
  #pubSub: PubSub;
  /**
   * The node ID for the server.
   */
  #nodeId: string;
  /**
   * The active sessions for the server.
   */
  #sessions = new Map<string, DocumentSession<Context>>();

  constructor(options: ServerOptions<Context>) {
    this.#options = options;
    this.logger = (options.logger ?? defaultLogger)
      .child()
      .withContext({ name: "server-v2" });
    this.#pubSub = options.pubSub ?? new InMemoryPubSub();
    this.#nodeId = options.nodeId ?? `node-${uuidv4()}`;
  }

  /**
   * Create or get a session for a document.
   * @param documentId - The ID of the document.
   * @param encrypted - Whether the document is encrypted.
   * @param id - The ID of the session.
   * @returns The session.
   */
  async getOrOpenSession(
    documentId: string,
    { encrypted, id = uuidv4() }: { encrypted: boolean; id?: string },
  ) {
    const existing = this.#sessions.get(documentId);
    if (existing) return existing;

    const storage = await this.#options.getStorage({
      documentId,
      context: { userId: "", room: "", clientId: "" } as any,
      encrypted,
    });

    const session = new DocumentSession<Context>({
      documentId,
      id,
      encrypted,
      storage,
      pubsub: this.#pubSub,
      nodeId: this.#nodeId,
      logger: this.logger,
    });

    await session.load();
    this.#sessions.set(documentId, session);
    return session;
  }

  /**
   * Create a client for a transport.
   * @param transport - The transport to use for the client.
   * @param id - The ID of the client.
   * @returns The client.
   */
  createClient({
    transport,
    id = uuidv4(),
  }: {
    transport: import("teleportal").Transport<Context>;
    id?: string;
  }) {
    const logger = this.logger.child().withContext({ clientId: id });

    const client = new Client<Context>({
      id,
      writable: transport.writable,
      logger,
    });

    withMessageValidator(transport, {
      isAuthorized: async (message, type) => {
        if (!this.#options.checkPermission) return true;
        const msgLogger = logger.child().withContext({ messageId: message.id });

        msgLogger.trace("checking permission");

        const ok = await this.#options.checkPermission({
          context: message.context,
          documentId: message.document,
          message,
          type,
        });

        msgLogger.trace(`Message authorized: ${ok}`);

        if (!ok) {
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
      },
    })
      .readable.pipeTo(
        new WritableStream<Message<Context>>({
          write: async (message) => {
            const session = await this.getOrOpenSession(message.document, {
              encrypted: message.encrypted,
            });
            session.addClient(client);
            await session.apply(message, client);
          },
        }),
      )
      .catch((e) => {
        logger.withError(e).error("client stream errored");
      })
      .finally(() => {
        this.disconnectClient(client.id);
      });

    return client;
  }

  /**
   * Disconnect a client from all sessions.
   * @param client - The client or client ID to disconnect.
   */
  disconnectClient(client: string | Client<Context>) {
    for (const s of this.#sessions.values()) {
      s.removeClient(client);
    }
  }

  /**
   * Async dispose the server.
   */
  async [Symbol.asyncDispose](): Promise<void> {
    for (const s of this.#sessions.values()) {
      await s[Symbol.asyncDispose]();
    }
    await this.#pubSub[Symbol.asyncDispose]?.();
  }
}
