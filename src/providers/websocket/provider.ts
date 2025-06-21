import { ObservableV2 } from "lib0/observable.js";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import type { YBinaryTransport } from "../../lib";
import { getYDocTransport } from "../../transports";
import { WebsocketConnection } from "./connection-manager";
import type { ReaderInstance } from "./utils";

export class Provider extends ObservableV2<{
  "load-subdoc": (subdoc: string) => void;
  "update-subdocs": () => void;
}> {
  public doc: Y.Doc;
  public awareness: Awareness;
  public transport: YBinaryTransport<{
    synced: Promise<void>;
  }>;
  public document: string;
  #websocketConnection: WebsocketConnection;
  #websocketReader: ReaderInstance;
  public subdocs: Map<string, Provider> = new Map();

  private constructor({
    client,
    document,
    doc = new Y.Doc(),
    awareness = new Awareness(doc),
    transport = getYDocTransport({
      ydoc: doc,
      document,
      awareness,
    }),
    wrapTransport = (transport) => transport,
  }: {
    client: WebsocketConnection;
    document: string;
    doc?: Y.Doc;
    awareness?: Awareness;
    transport?: YBinaryTransport<{
      synced: Promise<void>;
    }>;
    wrapTransport?: (
      transport: YBinaryTransport<{
        synced: Promise<void>;
      }>,
    ) => YBinaryTransport<{
      synced: Promise<void>;
    }>;
  }) {
    super();
    this.doc = doc;
    this.awareness = awareness;
    this.document = document;
    this.transport = wrapTransport(transport);
    this.#websocketConnection = client;
    this.#websocketReader = this.#websocketConnection.getReader();

    this.transport.readable.pipeTo(
      new WritableStream({
        write: (message) => {
          this.#websocketConnection.send(message);
        },
      }),
    );
    this.#websocketReader.readable.pipeTo(this.transport.writable);

    this.listenToSubdocs();
  }

  private listenToSubdocs() {
    // TODO all a hack at the moment
    this.doc.on("subdocs", ({ loaded, added, removed }) => {
      loaded.forEach((doc) => {
        const item = doc._item;
        if (!item) {
          throw new Error("doc._item is undefined");
        }
        const parentSub = item.parentSub;
        if (!parentSub) {
          throw new Error("doc._item.parentSub is undefined");
        }

        if (this.subdocs.has(parentSub)) {
          console.log("subdoc already exists", parentSub);
        }
        const provider = new Provider({
          client: this.#websocketConnection,
          doc,
          document: this.document + "/" + parentSub,
        });
        this.subdocs.set(parentSub, provider);
        this.emit("load-subdoc", [parentSub]);
      });
      // added.forEach((doc) => {
      //   console.log("added", doc.collectionid);
      //   console.log("doc", doc);
      // });
      removed.forEach((doc) => {
        console.log("removed", doc.collectionid);
      });
      this.emit("update-subdocs", []);
    });
  }

  /**
   * Switch this provider to a new document, destroying this provider instance.
   */
  public switchDocument(document: string): Provider {
    this.destroy({ destroyWebSocket: false });
    return this.openDocument(document);
  }

  /**
   * Create a new provider instance for a new document, without destroying this provider.
   */
  public openDocument(document: string): Provider {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);

    return new Provider({
      client: this.#websocketConnection,
      document,
      doc,
      awareness,
    });
  }

  /**
   * Resolves when both
   *  - the underlying websocket connection is connected
   *  - the transport is ready (i.e. we've synced the ydoc)
   */
  public get synced(): Promise<void> {
    return Promise.all([
      this.#websocketConnection.connected,
      this.transport.synced,
    ]).then(() => {});
  }

  public get state() {
    return this.#websocketConnection.state;
  }

  public destroy({
    destroyWebSocket = true,
  }: {
    destroyWebSocket?: boolean;
  } = {}) {
    super.destroy();
    // TODO how to clean up the transport?
    // this.transport.readable
    this.#websocketReader.unsubscribe();
    if (destroyWebSocket) {
      this.#websocketConnection.destroy();
    }
  }

  public [Symbol.dispose]() {
    this.destroy();
  }

  /**
   * Create a new provider instance, this will always attempt a new websocket connection.
   *
   * If you want to reuse an existing websocket connection see {@link Provider.createFromClient}
   */
  static async create({
    url,
    document,
    doc,
    awareness,
    transport,
    wrapTransport,
  }: {
    url: string;
    document: string;
    doc?: Y.Doc;
    awareness?: Awareness;
    transport?: YBinaryTransport<{
      synced: Promise<void>;
    }>;
    wrapTransport?: (
      transport: YBinaryTransport<{
        synced: Promise<void>;
      }>,
    ) => YBinaryTransport<{
      synced: Promise<void>;
    }>;
  }) {
    const client = new WebsocketConnection({ url });

    // Wait for the websocket to connect
    await client.connected;

    return Provider.createFromClient({
      client,
      document,
      doc,
      awareness,
      transport,
      wrapTransport,
    });
  }

  /**
   * Create a new provider instance, this will reuse an existing websocket connection.
   *
   * If you want to always create a new websocket connection see {@link Provider.create}
   */
  static async createFromClient({
    client,
    document,
    doc,
    awareness,
    transport,
    wrapTransport,
  }: {
    client: WebsocketConnection;
    document: string;
    doc?: Y.Doc;
    awareness?: Awareness;
    transport?: YBinaryTransport<{
      synced: Promise<void>;
    }>;
    wrapTransport?: (
      transport: YBinaryTransport<{
        synced: Promise<void>;
      }>,
    ) => YBinaryTransport<{
      synced: Promise<void>;
    }>;
  }) {
    return new Provider({
      client,
      doc,
      document,
      awareness,
      transport,
      wrapTransport,
    });
  }
}
