import { ObservableV2 } from "lib0/observable.js";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import { DocMessage, type StateVector, type YBinaryTransport } from "../../lib";
import { getYDocTransport } from "../../transports";
import { WebsocketConnection } from "./connection-manager";
import type { ReaderInstance } from "./utils";

export class Provider extends ObservableV2<{
  "load-subdoc": (subdoc: string) => void;
  "update-subdocs": () => void;
}> {
  public doc: Y.Doc;
  public awareness: Awareness;
  public transport: YBinaryTransport;
  public document: string;
  #websocketConnection: WebsocketConnection;
  #websocketReader: ReaderInstance;
  public subdocs: Map<string, Provider> = new Map();

  private constructor({
    client,
    doc,
    document,
    awareness = new Awareness(doc),
  }: {
    client: WebsocketConnection;
    doc: Y.Doc;
    document: string;
    awareness?: Awareness;
  }) {
    super();
    this.doc = doc;
    this.awareness = awareness;
    this.document = document;
    this.transport = getYDocTransport({
      ydoc: doc,
      document,
      awareness,
    });
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

    if (this.#websocketConnection.state.type === "connected") {
      this.beginSync();
    } else {
      this.#websocketConnection.once("open", this.beginSync);
    }
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

  public get synced(): Promise<void> {
    // TODO should probably also wait that we sent sync-step-1, and got back a sync-step-2
    return this.#websocketConnection.connected;
  }

  public get state() {
    return this.#websocketConnection.state;
  }

  private beginSync() {
    this.#websocketConnection.send(
      new DocMessage(this.document, {
        type: "sync-step-1",
        sv: Y.encodeStateVectorFromUpdateV2(
          Y.encodeStateAsUpdateV2(this.doc),
        ) as StateVector,
      }).encoded,
    );
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
    doc = new Y.Doc(),
    awareness = new Awareness(doc),
  }: {
    url: string;
    document: string;
    doc?: Y.Doc;
    awareness?: Awareness;
  }) {
    const client = new WebsocketConnection({ url });

    // Wait for the websocket to connect
    await client.connected;

    return Provider.createFromClient({ client, document, doc, awareness });
  }

  /**
   * Create a new provider instance, this will reuse an existing websocket connection.
   *
   * If you want to always create a new websocket connection see {@link Provider.create}
   */
  static async createFromClient({
    client,
    document,
    doc = new Y.Doc(),
    awareness = new Awareness(doc),
  }: {
    client: WebsocketConnection;
    document: string;
    doc?: Y.Doc;
    awareness?: Awareness;
  }) {
    return new Provider({
      client,
      doc,
      document,
      awareness,
    });
  }
}
