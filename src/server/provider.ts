import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { WebsocketClient } from "./web-socket-client";
import {
  BinaryMessage,
  DocMessage,
  StateVector,
  YBinaryTransport,
} from "../lib";
import { getYDocTransport } from "../transports/ydoc";
import { ReaderInstance } from "../transports/utils";
import { ObservableV2 } from "lib0/observable.js";

export class Provider extends ObservableV2<{
  "load-subdoc": (subdoc: string) => void;
  "update-subdocs": () => void;
}> {
  public doc: Y.Doc;
  public awareness: Awareness;
  public transport: YBinaryTransport;
  public document: string;
  #websocketClient: WebsocketClient;
  #readerInstance: ReaderInstance;
  public subdocs: Map<string, Provider> = new Map();

  constructor({
    client,
    doc,
    document,
    awareness = new Awareness(doc),
  }: {
    client: WebsocketClient;
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
    this.#websocketClient = client;
    this.#readerInstance = this.#websocketClient.getReader();

    this.transport.readable.pipeTo(
      new WritableStream({
        write: (message) => {
          this.#websocketClient.send(message);
        },
      }),
    );

    this.#readerInstance.readable.pipeTo(this.transport.writable);

    if (this.#websocketClient.state.type !== "connected") {
      this.#websocketClient.once("open", this.onConnect);
    } else {
      this.onConnect();
    }
    this.listenToSubdocs();
  }

  private listenToSubdocs() {
    // TODO all a hack at the moment
    console.log("doc.collectionid", this.doc.collectionid);
    console.log(this.doc);
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
          client: this.#websocketClient,
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

  public get state() {
    return this.#websocketClient.state;
  }

  private onConnect() {
    this.#websocketClient.send(
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
    this.#readerInstance.unsubscribe();
    if (destroyWebSocket) {
      this.#websocketClient.destroy();
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
    const client = new WebsocketClient({ url });

    // Wait for the websocket to connect
    await new Promise((resolve, reject) => {
      let handled = false;
      client.once("close", () => {
        if (!handled) {
          handled = true;
          reject(new Error("WebSocket closed"));
        }
      });
      client.once("open", () => {
        if (!handled) {
          handled = true;
          resolve(null);
        }
      });
    });

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
    client: WebsocketClient;
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
