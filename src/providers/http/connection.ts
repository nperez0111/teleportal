import {
  Message,
  RawReceivedMessage,
  type Source,
  type ClientContext,
} from "teleportal";
import { getHTTPSink, getSSESource } from "teleportal/transports";
import { Connection, ConnectionOptions } from "../connection";

export type HttpConnectContext = {
  connected: {
    clientId: string;
    lastEventId: string;
  };
  disconnected: {
    clientId: null;
    lastEventId: null;
  };
  connecting: {
    clientId: null;
    lastEventId: null;
  };
  errored: {
    reconnectAttempt: number;
  };
};

export type HttpConnectionOptions = {
  url: string;
} & Omit<ConnectionOptions, "heartbeatInterval">;

export class HttpConnection extends Connection<HttpConnectContext> {
  #httpWriter: WritableStreamDefaultWriter<RawReceivedMessage> | undefined;
  #url: string;

  constructor(options: HttpConnectionOptions) {
    super(options);
    this.#url = options.url;

    // Initialize the state with the correct HTTP context
    this._state = {
      type: "disconnected",
      context: { clientId: null, lastEventId: null },
    };
  }

  #source: ReturnType<typeof getSSESource> | undefined;

  protected async initConnection(): Promise<void> {
    if (this.destroyed) {
      throw new Error("HttpConnection is destroyed, create a new instance");
    }

    if (!this.shouldAttemptConnection()) {
      return;
    }

    if (this.state.type === "connected" || this.state.type === "connecting") {
      return;
    }

    this.setState({
      type: "connecting",
      context: { clientId: null, lastEventId: null },
    });

    const sseSource = new URL(this.#url);
    sseSource.pathname += sseSource.pathname.endsWith("/") ? "sse" : "/sse";

    this.#source = getSSESource({
      context: {} as ClientContext,
      source: new EventSource(sseSource.toString()),
      onPing: () => {
        this.updateLastMessageReceived();
      },
    });

    try {
      // Wait for the clientId to be set by the SSE source
      const clientId = await this.#source.clientId;

      // Setup for the HTTP sink
      const context = { clientId } satisfies ClientContext;
      const httpSink = new URL(this.#url);
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

      this.#source.readable.pipeTo(
        new WritableStream({
          write: async (chunk) => {
            this.updateLastMessageReceived();
            await this.writer.write(chunk);
          },
        }),
        // TODO likely can do something at the end of this pipe, either cleanup or schedule a reconnect
      );
      this.#httpWriter = sink.writable.getWriter();
      this.setState({
        type: "connected",
        context: { clientId, lastEventId: "client-id" },
      });
      this.updateLastMessageReceived();
    } catch (error) {
      this.handleConnectionError(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  protected sendMessage(message: Message): void {
    if (this.#httpWriter) {
      this.#httpWriter.write(message);
    }
  }

  protected async closeConnection(): Promise<void> {
    if (this.#httpWriter) {
      await this.#httpWriter.close();
      this.#httpWriter = undefined;
    }
    if (this.#source) {
      this.#source.eventSource.close();
      this.#source = undefined;
    }
    this.setState({
      type: "disconnected",
      context: { clientId: null, lastEventId: null },
    });
  }

  public async destroy(): Promise<void> {
    if (this.destroyed) {
      return;
    }
    this.#httpWriter?.releaseLock();
    await super.destroy();
  }
}
