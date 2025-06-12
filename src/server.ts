import { uuidv4 } from "lib0/random";
import type { ServerContext, YTransport } from "./base";
import { Client } from "./client";
import { Document, getDocumentId } from "./document";
import type { ReceivedMessage } from "./protocol";
import type { DocumentStorage } from "./storage";

export type ServerOptions<Context extends ServerContext> = {
  getStorage: (ctx: {
    context: Context;
    server: Server<Context>;
  }) => Promise<DocumentStorage>;
  /**
   * Check if a client has permission to access a document.
   * @note This is called on every message sent, so it should be fast.
   * @returns True if the client has permission, false otherwise.
   */
  checkPermission: (ctx: {
    /**
     * The context of the client.
     */
    context: Context;
    /**
     * The name of the document.
     */
    document: string;
    /**
     * The unique identifier of the document.
     */
    documentId: string;
    /**
     * The client that is trying to access the document.
     */
    client: Client<Context>;
    /**
     * The message that is being sent.
     */
    message: ReceivedMessage<Context>;
  }) => Promise<boolean>;
};

export class Server<Context extends ServerContext> {
  public readonly clients: Map<string, Client<Context>> = new Map();
  public readonly documents: Map<string, Document<Context>> = new Map();
  public readonly options: ServerOptions<Context>;

  constructor(options: ServerOptions<Context>) {
    this.options = options;
  }

  public async getOrCreateDocument(name: string, context: Context) {
    const key = getDocumentId(name, context);

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

  public async createClient(
    transport: YTransport<Context, any>,
    context: Omit<Context, "clientId">,
  ) {
    const id = uuidv4();

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
      context: Object.assign(
        {
          clientId: id,
        },
        context,
      ) as Context,
    });

    this.clients.set(id, client);

    return client;
  }
}
