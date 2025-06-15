import { ObservableV2 } from "lib0/observable.js";
import { BinaryMessage, YBinaryTransport } from "../lib";
import { createMultiReader } from "../transports/utils";

const messageReconnectTimeout = 30000;
const maxBackoffTime = 2500;

export type WebsocketState =
  | {
      type: "connecting";
      ws: WebSocket;
    }
  | {
      type: "connected";
      ws: WebSocket;
    }
  | {
      type: "disconnected";
      ws: null;
    }
  | {
      type: "error";
      ws: WebSocket;
      error: Error;
    };

export class WebsocketClient extends ObservableV2<{
  update: (state: WebsocketState) => void;
  message: (message: BinaryMessage) => void;
  close: (event: CloseEvent) => void;
  open: () => void;
}> {
  #wsUnsuccessfulReconnects = 0;
  #wsLastMessageReceived = 0;
  #shouldConnect = true;
  #checkInterval: ReturnType<typeof setInterval> | null = null;
  #url: string;
  #protocols: string[];
  #state: WebsocketState = { type: "disconnected", ws: null };
  public writable: WritableStream<BinaryMessage> = new WritableStream({
    write: (message) => {
      this.send(message);
    },
  });
  public multiReader = createMultiReader();
  public isDestroyed = false;

  public get state() {
    return this.#state;
  }

  public set state(state: WebsocketState) {
    this.#state = state;
    this.emit("update", [state]);
  }

  constructor({
    url,
    protocols = [],
    connect = true,
  }: {
    url: string;
    protocols?: string[];
    connect?: boolean;
  }) {
    super();
    this.#url = url;
    this.#protocols = protocols;

    if (connect) {
      this._setupWebSocket();
    }

    this.#checkInterval = setInterval(() => {
      if (
        this.state.type === "connected" &&
        messageReconnectTimeout < Date.now() - this.#wsLastMessageReceived
      ) {
        // No message received in a long time
        this._closeWebSocketConnection();
      }
    }, messageReconnectTimeout / 10);
  }

  private _setupWebSocket() {
    if (this.isDestroyed) {
      throw new Error("WebsocketClient is destroyed, create a new instance");
    }
    if (this.#shouldConnect) {
      const websocket = new WebSocket(this.#url, this.#protocols);
      websocket.binaryType = "arraybuffer";
      this.state = { type: "connecting", ws: websocket };

      websocket.onmessage = async (event) => {
        this.#wsLastMessageReceived = Date.now();
        this.emit("message", [
          new Uint8Array(event.data as ArrayBuffer) as BinaryMessage,
        ]);
      };

      websocket.onerror = (event) => {
        this.state = {
          type: "error",
          ws: websocket,
          error: new Error("WebSocket error", { cause: event }),
        };
      };
      const writable = new WritableStream({
        write: (message) => {
          const writer = this.multiReader.writable.getWriter();
          writer.write(message);
          writer.releaseLock();
        },
      });

      websocket.onclose = (event) => {
        this._closeWebSocketConnection();
        this.emit("close", [event]);
        writable.abort();
      };

      websocket.onopen = () => {
        this.#wsLastMessageReceived = Date.now();
        this.#wsUnsuccessfulReconnects = 0;
        this.state = { type: "connected", ws: websocket };
        this.emit("open", []);
      };

      // TODO this is sort of awkward
      new ReadableStream({
        start: async (controller) => {
          this.on("message", (message) => {
            controller.enqueue(message);
          });
          await new Promise((resolve) => {
            this.once("open", () => {
              resolve(undefined);
            });
          });
        },
      }).pipeTo(writable);
    }
  }

  public getReader() {
    return this.multiReader.getReader();
  }

  private _closeWebSocketConnection() {
    if (this.state.ws) {
      this.state.ws.close();
      const wasConnected = this.state.type === "connected";
      this.state = { type: "disconnected", ws: null };

      if (wasConnected) {
        this.#wsUnsuccessfulReconnects++;
      }

      // Start with no reconnect timeout and increase timeout by
      // using exponential backoff starting with 100ms
      setTimeout(
        () => this._setupWebSocket(),
        Math.min(
          Math.pow(2, this.#wsUnsuccessfulReconnects) * 100,
          maxBackoffTime,
        ),
      );
    }
  }

  public send(data: BinaryMessage) {
    if (this.isDestroyed) {
      throw new Error("WebsocketClient is destroyed, create a new instance");
    }
    if (
      this.state.type === "connected" &&
      this.state.ws.readyState === WebSocket.OPEN
    ) {
      this.state.ws.send(data);
    }
  }

  public destroy() {
    if (this.isDestroyed) {
      return;
    }
    super.destroy();
    this.isDestroyed = true;
    if (this.#checkInterval !== null) {
      clearInterval(this.#checkInterval);
    }
    this.#shouldConnect = false;
    if (this.state.ws) {
      this._closeWebSocketConnection();
    }
  }

  [Symbol.dispose]() {
    this.destroy();
  }

  public connect() {
    if (this.isDestroyed) {
      throw new Error("WebsocketClient is destroyed, create a new instance");
    }
    this.#shouldConnect = true;
    if (this.state.type === "disconnected") {
      this._setupWebSocket();
    }
  }

  public disconnect() {
    this.#shouldConnect = false;
    if (this.state.ws) {
      this._closeWebSocketConnection();
    }
  }
}
