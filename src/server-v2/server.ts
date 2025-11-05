import { uuidv4 } from "lib0/random";
import { DocMessage, type Message, type ServerContext } from "teleportal";
import type { DocumentStorage } from "teleportal/storage";
import { logger as defaultLogger, type Logger } from "../server/logger";
import type { ServerOptions } from "./api/types";
import { Engine } from "./engine/engine";
import { createInMemoryReplicator } from "./replication/inmemory";
import { PubSubReplicator, type Replicator } from "./replication/replicator";
import { Session as DocumentSession } from "./session/session";

export class Client<Context extends ServerContext> {
  public readonly id: string;
  #writable: WritableStream<Message<Context>>;
  #logger: Logger;

  constructor(args: { id: string; writable: WritableStream<Message<Context>>; logger: Logger }) {
    this.id = args.id;
    this.#writable = args.writable;
    this.#logger = args.logger.child().withContext({ name: "client", clientId: this.id });
  }

  async send(message: Message<Context>): Promise<void> {
    const writer = this.#writable.getWriter();
    try {
      await writer.ready;
      await writer.write(message);
    } finally {
      writer.releaseLock();
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {}
}

export class Server<Context extends ServerContext> {
  #logger: Logger;
  #options: ServerOptions<Context>;
  #engine: Engine<Context>;
  #replicator: Replicator;
  #sessions = new Map<string, DocumentSession<Context>>();

  constructor(options: ServerOptions<Context>) {
    this.#options = options;
    this.#logger = (options.logger ?? defaultLogger).child().withContext({ name: "server-v2" });
    this.#replicator = options.replicator ?? createInMemoryReplicator();
    this.#engine = new Engine({ logger: this.#logger, serverOptions: this.#options });
  }

  async getOrOpenSession(documentId: string, { encrypted, name = documentId }: { encrypted: boolean; name?: string }) {
    const existing = this.#sessions.get(documentId);
    if (existing) return existing;

    const storage = await this.#options.getStorage({ documentId, document: name, context: { userId: "", room: "", clientId: "" } as any, encrypted });

    const session = new DocumentSession<Context>({
      documentId,
      name,
      encrypted,
      storage,
      replicator: this.#replicator,
      logger: this.#logger,
    });

    await session.load();
    this.#sessions.set(documentId, session);
    return session;
  }

  async createClient({ transport, id = uuidv4() }: { transport: import("teleportal").Transport<Context>; id?: string }) {
    if (this.#sessions.size === Number.NaN) {
      // noop to satisfy lints in some configs
    }
    const logger = this.#logger.child().withContext({ clientId: id });

    const client = new Client<Context>({ id, writable: transport.writable, logger });

    const validated = this.#engine.wrapTransport(transport, async (m) => client.send(m));

    validated.readable
      .pipeTo(
        new WritableStream<Message<Context>>({
          write: async (message) => {
            const documentId = message.document; // canonical per plan (no room in key)
            const session = await this.getOrOpenSession(documentId, { encrypted: message.encrypted, name: message.document });
            session.addClient(client);
            await session.apply(message, client);
          },
        }),
      )
      .catch((e) => {
        logger.withError?.(e as any).error?.("client stream errored");
      })
      .finally(async () => {
        for (const s of this.#sessions.values()) {
          s.removeClient(client);
        }
      });

    return client;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    for (const s of this.#sessions.values()) {
      await s[Symbol.asyncDispose]();
    }
    await this.#replicator[Symbol.asyncDispose]();
  }
}

export * as types from "./api/types";
