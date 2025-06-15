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

export class Provider {
  public doc: Y.Doc;
  public awareness: Awareness;
  public transport: YBinaryTransport;
  public document: string;
  #websocketClient: WebsocketClient;

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
    this.doc = doc;
    this.awareness = awareness;
    this.document = document;
    this.transport = getYDocTransport({
      ydoc: doc,
      document,
      awareness,
    });
    this.#websocketClient = client;

    this.transport.readable.pipeTo(
      new WritableStream({
        write: (message) => {
          this.#websocketClient.send(message);
        },
      }),
    );

    this.#websocketClient.on("message", async (message) => {
      const writer = this.transport.writable.getWriter();
      await writer.write(message as BinaryMessage);
      writer.releaseLock();
    });

    if (this.#websocketClient.state.type !== "connected") {
      this.#websocketClient.on("open", this.onConnect);
    } else {
      this.onConnect();
    }
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

  static async create({ url, document }: { url: string; document: string }) {
    const client = new WebsocketClient({ url });
    await new Promise((resolve, reject) => {
      client.on("open", () => {
        resolve(null);
      });
      // TODO: handle error
      // client.on('error')
    });
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    const provider = new Provider({
      client,
      doc,
      document,
      awareness,
    });
    return provider;
  }
}
