import { ObservableV2 } from "lib0/observable.js";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import {
  DocMessage,
  StateVector,
  toBinaryTransport,
  type ClientContext,
  type YBinaryTransport,
  type YTransport,
} from "teleportal";
import { getYTransportFromYDoc } from "../../transports";
import { WebsocketConnection } from "./connection-manager";
import type { ReaderInstance } from "./utils";

export type ProviderOptions = {
  client: WebsocketConnection;
  document: string;
  ydoc?: Y.Doc;
  awareness?: Awareness;
  getTransport?: (ctx: {
    ydoc: Y.Doc;
    document: string;
    awareness: Awareness;
    getDefaultTransport(): YTransport<
      ClientContext,
      {
        synced: Promise<void>;
      }
    >;
  }) => YTransport<
    ClientContext,
    {
      synced: Promise<void>;
    }
  >;
};

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
  #getTransport: ProviderOptions["getTransport"];
  public subdocs: Map<string, Provider> = new Map();

  private constructor({
    client,
    document,
    ydoc = new Y.Doc(),
    awareness = new Awareness(ydoc),
    getTransport = ({ getDefaultTransport }) => getDefaultTransport(),
  }: ProviderOptions) {
    super();
    this.doc = ydoc;
    this.awareness = awareness;
    this.document = document;
    this.#getTransport = getTransport;
    this.transport = toBinaryTransport(
      getTransport({
        ydoc,
        document,
        awareness,
        getDefaultTransport() {
          return getYTransportFromYDoc({ ydoc, document, awareness });
        },
      }),
      { clientId: "remote" },
    );
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

    if (client.state.type === "connected") {
      this.init();
    }
    client.on("open", this.init);
  }

  private init() {
    this.#websocketConnection.send(
      new DocMessage(
        this.document,
        {
          type: "sync-step-1",
          sv: Y.encodeStateVector(this.doc) as StateVector,
        },
        { clientId: "local" },
      ).encoded,
    );
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
          ydoc: doc,
          document: this.document + "/" + parentSub,
          getTransport: this.#getTransport,
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
  public switchDocument(options: Omit<ProviderOptions, "client">): Provider {
    this.destroy({ destroyWebSocket: false });
    return this.openDocument(options);
  }

  /**
   * Create a new provider instance for a new document, without destroying this provider.
   */
  public openDocument(options: Omit<ProviderOptions, "client">): Provider {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);

    return new Provider({
      client: this.#websocketConnection,
      ydoc: doc,
      awareness,
      getTransport: this.#getTransport,
      ...options,
    });
  }

  #synced: Promise<void> | null = null;
  /**
   * Resolves when both
   *  - the underlying websocket connection is connected
   *  - the transport is ready (i.e. we've synced the ydoc)
   */
  public get synced(): Promise<void> {
    if (this.#synced) {
      // re-use the promise if the underlying connection is unchanged
      return this.#synced;
    }
    const synced = Promise.all([
      this.#websocketConnection.connected,
      this.transport.synced,
    ]).then(() => {});

    this.#synced = synced;
    // if the underlying connection changes, then clear out the cached promise
    this.#websocketConnection.once("update", () => {
      this.#synced = null;
    });
    return synced;
  }

  public get state() {
    return this.#websocketConnection.state;
  }

  public destroy({
    destroyWebSocket = true,
    destroyDoc = true,
  }: {
    destroyWebSocket?: boolean;
    destroyDoc?: boolean;
  } = {}) {
    super.destroy();
    // TODO how to clean up the transport?
    // this.transport.readable
    this.#websocketReader.unsubscribe();
    if (destroyWebSocket) {
      this.#websocketConnection.destroy();
    }
    if (destroyDoc) {
      this.doc.destroy();
    }
  }

  public [Symbol.dispose]() {
    this.destroy();
  }

  /**
   * Create a new provider instance, this will always attempt a new websocket connection.
   *
   * If you want to reuse an existing websocket connection provide the `client` option.
   */
  static async create({
    url,
    document,
    ydoc,
    awareness,
    getTransport,
    client = new WebsocketConnection({ url: url! }),
  }: (
    | { url: string; client?: undefined }
    | { url?: undefined; client: WebsocketConnection }
  ) &
    Omit<ProviderOptions, "client">) {
    // Wait for the websocket to connect
    await client.connected;

    return new Provider({
      client,
      ydoc,
      document,
      awareness,
      getTransport,
    });
  }
}
