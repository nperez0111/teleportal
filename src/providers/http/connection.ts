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
  #source: ReturnType<typeof getSSESource> | undefined;
  #streamAbortController: AbortController | undefined;
  #initInProgress: Promise<void> | null = null;

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

  protected async initConnection(): Promise<void> {
    // Prevent concurrent initialization attempts
    if (this.#initInProgress) {
      return this.#initInProgress;
    }

    if (this.destroyed) {
      throw new Error("HttpConnection is destroyed, create a new instance");
    }

    if (!this.shouldAttemptConnection()) {
      return;
    }

    // Prevent concurrent connection attempts - only use state
    if (this.state.type === "connected" || this.state.type === "connecting") {
      return;
    }

    try {
      this.#initInProgress = (async () => {
        // Clean up any existing resources
        await this.#cleanupResources();

        // Set state to connecting first
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
            this.call("ping");
          },
        });

        // Wait for the clientId to be set by the SSE source
        const clientId = await this.#source.clientId;

        // Ensure we are still active
        if (this.destroyed) {
          await this.#cleanupResources();
          return;
        }

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
              throw new Error(
                `HTTP request failed with status ${resp.status}: ${resp.statusText}`,
              );
            }
          },
        });

        // Set up stream processing with abort controller
        this.#streamAbortController = new AbortController();
        const signal = this.#streamAbortController.signal;

        // Set up the readable stream processing
        const streamProcessingPromise = this.#source.readable
          .pipeTo(
            new WritableStream({
              write: async (chunk) => {
                // Check if operation was aborted
                if (signal.aborted) {
                  throw new Error("Stream processing aborted");
                }

                this.updateLastMessageReceived();

                // Only update state if we are still active
                if (!this.destroyed) {
                  this.setState({
                    type: "connected",
                    context: { clientId, lastEventId: chunk.id },
                  });
                }

                await this.writer.write(chunk);
              },
              abort: (reason) => {
                console.warn("HTTP stream processing aborted:", reason);
              },
            }),
            { signal },
          )
          .catch((error) => {
            // Only handle errors if we're still active
            if (!this.destroyed && !signal.aborted) {
              console.warn("HTTP stream processing error:", error);
              this.handleConnectionError(
                error instanceof Error ? error : new Error(String(error)),
              );
            }
          })
          .finally(() => {
            // Clean up and set disconnected state if this is still active
            if (!this.destroyed) {
              this.closeConnection();
            }
          });

        // Get the writer for sending messages
        this.#httpWriter = sink.writable.getWriter();

        // Only set connected state if we are still active
        if (!this.destroyed) {
          this.setState({
            type: "connected",
            context: { clientId, lastEventId: "client-id" },
          });
          this.updateLastMessageReceived();
        }
      })();

      await this.#initInProgress;
    } catch (error) {
      if (!this.destroyed) {
        this.handleConnectionError(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    } finally {
      this.#initInProgress = null;
    }
  }

  async #cleanupResources(): Promise<void> {
    // Abort any ongoing stream processing
    if (this.#streamAbortController) {
      this.#streamAbortController.abort("Connection cleanup");
      this.#streamAbortController = undefined;
    }

    // Close and clean up HTTP writer
    if (this.#httpWriter) {
      try {
        if (!this.#httpWriter.closed) {
          await this.#httpWriter.close();
        }
      } catch (error) {
        // Ignore errors when closing writer, it might already be closed
      } finally {
        try {
          this.#httpWriter.releaseLock();
        } catch (error) {
          // Ignore errors when releasing lock
        }
        this.#httpWriter = undefined;
      }
    }

    // Close and clean up EventSource
    if (this.#source) {
      try {
        this.#source.eventSource.close();
      } catch (error) {
        // Ignore errors when closing EventSource
      }
      this.#source = undefined;
    }
  }

  protected async sendMessage(message: Message): Promise<void> {
    if (
      this.state.type === "connected" &&
      this.#httpWriter &&
      !this.#httpWriter.closed
    ) {
      try {
        await this.#httpWriter.write(message);
      } catch (error) {
        // If it's a serious error, handle it
        if (error instanceof Error && error.name !== "AbortError") {
          this.handleConnectionError(error);
        }
        throw error; // Re-throw to let base class handle buffering
      }
    } else {
      throw new Error("Not connected - message should be buffered");
    }
  }

  protected async closeConnection(): Promise<void> {
    await this.#cleanupResources();

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

    await this.#cleanupResources();
    await super.destroy();
  }
}
