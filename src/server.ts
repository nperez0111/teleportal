import type { ServerContext, YTransport } from "./base";
import { Client } from "./client";
import { Document, getDocumentKey } from "./document";
import type { DocumentStorage } from "./storage";

export type ServerOptions<Context extends ServerContext> = {
  getStorage: (ctx: {
    context: Context;
    server: Server<Context>;
  }) => Promise<DocumentStorage>;
};

export class Server<Context extends ServerContext> {
  public readonly clients: Map<string, Client<Context>> = new Map();
  public readonly documents: Map<string, Document<Context>> = new Map();
  public readonly options: ServerOptions<Context>;

  constructor(options: ServerOptions<Context>) {
    this.options = options;
  }

  public async getOrCreateDocument(name: string, context: Context) {
    const key = getDocumentKey(name, context);

    if (this.documents.has(key)) {
      return this.documents.get(key)!;
    }

    const storage = await this.options.getStorage({
      context,
      server: this,
    });

    if (!storage) {
      throw new Error(`Storage not found`, { cause: { context } });
    }

    const doc = new Document<Context>({
      name,
      server: this,
      storage,
      hooks: {
        onUnload: () => {
          this.documents.delete(key);
        },
      },
    });

    this.documents.set(key, doc);

    return doc;
  }

  public async createClient(id: string, transport: YTransport<Context, any>) {
    if (this.clients.has(id)) {
      throw new Error(`Client with same id already exists`, { cause: { id } });
    }

    const client = new Client<Context>({
      id,
      hooks: {},
      /**
       * What is nice about this is that we can wrap the transport of a client to
       * see what actually is being read and written to the client.
       * We will also implement the binary encoding/decoding here.
       */
      transport,
      server: this,
    });

    this.clients.set(id, client);

    return client;
  }
}
