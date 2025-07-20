import { Message, RawReceivedMessage, type ClientContext } from "teleportal";
import { getHTTPSink, getSSESource } from "teleportal/transports";
import { Connection, ConnectionOptions } from "../connection";

export type HttpConnectContext = {
  connected: {
    clientId: string;
    lastEventId: string;
  };
  disconnected: {
    clientId: string | null;
    lastEventId: string | null;
  };
  connecting: {
    clientId: string | null;
    lastEventId: string | null;
  };
  errored: {
    clientId: string | null;
    lastEventId: string | null;
    reconnectAttempt: number;
  };
};

export type HttpConnectionOptions = {
  url: string;
  /**
   * The fetch implementation to use
   */
  fetch?: typeof fetch;
  /**
   * The EventSource implementation to use
   */
  EventSource?: typeof EventSource;
} & Omit<ConnectionOptions, "heartbeatInterval">;

export class HttpConnection extends Connection<HttpConnectContext> {
  #httpWriter: WritableStreamDefaultWriter<RawReceivedMessage> | undefined;
  #url: string;
  #fetch: typeof fetch;
  #EventSource: typeof EventSource;

  constructor(options: HttpConnectionOptions) {
    super(options);
    this.#url = options.url;
    this.#fetch = options.fetch ?? fetch.bind(globalThis);
    this.#EventSource = options.EventSource ?? EventSource;

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
      context: {
        clientId: this.state.context.clientId,
        lastEventId: this.state.context.lastEventId,
      },
    });

    const sseSource = new URL(this.#url);
    sseSource.pathname += sseSource.pathname.endsWith("/") ? "sse" : "/sse";

    this.#source = getSSESource({
      context: {} as ClientContext,
      source: new this.#EventSource(sseSource.toString()),
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
          const resp = await this.#fetch(httpSink.toString(), requestOptions);
          if (!resp.ok) {
            throw new Error("Failed to fetch");
          }
        },
      });

      this.#source.readable
        .pipeTo(
          new WritableStream({
            write: async (chunk) => {
              this.updateLastMessageReceived();
              this.setState({
                type: "connected",
                context: { clientId, lastEventId: chunk.id },
              });
              await this.writer.write(chunk);
            },
          }),
        )
        .finally(() => {
          // This will set the state to disconnected and trigger reconnection
          this.closeConnection();
        });
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

  protected async sendMessage(message: Message): Promise<void> {
    if (this.state.type === "connected" && this.#httpWriter) {
      await this.#httpWriter.write(message);
    } else {
      await this.sendOrBuffer(message);
    }
  }

  protected async closeConnection(): Promise<void> {
    if (this.#httpWriter) {
      try {
        await this.#httpWriter.close();
      } catch (error) {
        // Ignore errors when closing writer, it might already be closed
      }
      this.#httpWriter = undefined;
    }
    if (this.#source) {
      this.#source.eventSource.close();
      this.#source = undefined;
    }

    this.setState({
      type: "disconnected",
      context: {
        clientId: this.state.context.clientId,
        lastEventId: this.state.context.lastEventId,
      },
    });
  }

  public async destroy(): Promise<void> {
    if (this.destroyed) {
      return;
    }
    if (this.#httpWriter) {
      try {
        this.#httpWriter.releaseLock();
      } catch (error) {
        // Ignore errors when releasing lock, it might already be released
      }
    }
    await super.destroy();
  }
}
