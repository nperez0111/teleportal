import { EventSource } from "eventsource";
import {
  ClientContext,
  Message,
  Observable,
  RawReceivedMessage,
  Transport,
} from "teleportal";
import {
  compose,
  createFanOutWriter,
  FanOutReader,
  getHTTPSink,
  getSSESource,
} from "teleportal/transports";
import { Connection, ConnectionState } from "../connection";

export type HttpConnectContext = {
  connected: {
    clientId: string;
    lastEventId: string;
  };
  disconnected: {
    clientId: null;
    lastEventId: string | null;
  };
  connecting: {
    clientId: string | null;
    lastEventId: string | null;
  };
  errored: {
    lastEventId: string | null;
  };
};

export class HttpConnection
  extends Observable<{
    update: (state: ConnectionState<HttpConnectContext>) => void;
    message: (message: Message) => void;
    connected: () => void;
    disconnected: () => void;
  }>
  implements Connection<HttpConnectContext>
{
  #fanOutWriter = createFanOutWriter<RawReceivedMessage>();
  #writable = this.#fanOutWriter.writable;
  #writer: WritableStreamDefaultWriter<RawReceivedMessage> | undefined;
  #transport:
    | Transport<ClientContext, { clientId: Promise<string> }>
    | undefined;
  #baseUrl: string;
  // TODO should this actually just be a parameter of connect?
  #documents: string[];
  #state: ConnectionState<HttpConnectContext> = {
    type: "disconnected",
    context: { clientId: null, lastEventId: null },
  };

  #setState(state: ConnectionState<HttpConnectContext>) {
    this.#state = state;
    this.call("update", state);
    switch (state.type) {
      case "connected":
        this.call("connected");
        break;
      case "disconnected":
        this.call("disconnected");
        break;
    }
  }

  constructor({
    connect = true,
    baseUrl,
    documents,
  }: {
    connect?: boolean;
    baseUrl: string;
    documents: string[];
  }) {
    super();
    this.#baseUrl = baseUrl;
    this.#documents = documents;

    if (connect) {
      this.connect();
    }
  }

  send(message: Message): void {
    if (this.#writer) {
      this.#writer.write(message);
    }
  }

  async connect() {
    if (this.destroyed) {
      throw new Error("HttpConnection is destroyed, create a new instance");
    }
    this.#setState({
      type: "connecting",
      context: { clientId: null, lastEventId: null },
    });
    const sseSource = new URL(this.#baseUrl);
    sseSource.pathname += sseSource.pathname.endsWith("/") ? "sse" : "/sse";
    sseSource.searchParams.set("documents", this.#documents.join(","));

    const source = getSSESource({
      context: {} as ClientContext,
      source: new EventSource(sseSource.toString()),
    });

    // Wait for the clientId to be set by the SSE source
    const clientId = await source.clientId;

    // Setup for the HTTP sink
    const context = { clientId } satisfies ClientContext;
    const httpSink = new URL(this.#baseUrl);
    httpSink.pathname += httpSink.pathname.endsWith("/") ? "sse" : "/sse";

    const sink = getHTTPSink({
      context,
      request: async ({ requestOptions }) => {
        // Send the message to the HTTP sink
        const resp = await fetch(httpSink.toString(), requestOptions);
        if (!resp.ok) {
          throw new Error("Failed to fetch");
        }
      },
    });

    source.readable.pipeTo(this.#writable);
    this.#writer = sink.writable.getWriter();
    this.#setState({
      type: "connected",
      context: { clientId, lastEventId: "client-id" },
    });
  }
  async disconnect() {
    if (this.destroyed) {
      throw new Error("HttpConnection is destroyed, create a new instance");
    }
  }

  get state(): ConnectionState<HttpConnectContext> {
    return this.#state;
  }

  getReader(): FanOutReader<RawReceivedMessage> {
    return this.#fanOutWriter.getReader();
  }

  get connected(): Promise<void> {
    const currentState = this.state;
    switch (currentState.type) {
      case "disconnected":
      case "connecting": {
        return new Promise((resolve, reject) => {
          let handled = false;
          const unsubscribe = this.on("update", (state) => {
            if (!handled) {
              if (state.type === "connected") {
                handled = true;
                unsubscribe();
                resolve();
              } else if (state.type === "errored") {
                handled = true;
                unsubscribe();
                reject(state.error);
              }
            }
          });
        });
      }
      case "connected": {
        return Promise.resolve();
      }
      case "errored": {
        return Promise.reject(currentState.error);
      }
    }
  }

  public destroyed: boolean = false;

  public destroy(): void {
    if (this.destroyed) {
      return;
    }
    super.destroy();
    this.destroyed = true;

    this.#writable.close();
  }
}
