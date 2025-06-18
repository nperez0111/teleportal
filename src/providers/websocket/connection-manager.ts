import { ObservableV2 } from "lib0/observable.js";
import {
  encodePingMessage,
  isPongMessage,
  type BinaryMessage,
} from "../../lib";
import { createFanOutWriter } from "./utils";

const MESSAGE_RECONNECT_TIMEOUT = 30000;
const MAX_BACKOFF_TIME = 2500;
const HEARTBEAT_INTERVAL = 10000;
const INITIAL_RECONNECT_DELAY = 100;
const MAX_RECONNECT_ATTEMPTS = 10;

export type WebsocketState =
  | {
      type: "offline";
      ws: null;
    }
  | {
      type: "connecting";
      ws: WebSocket;
    }
  | {
      type: "connected";
      ws: WebSocket;
    }
  | {
      type: "error";
      ws: WebSocket | null;
      error: Error;
      reconnectAttempt: number;
    };

export class WebsocketConnection extends ObservableV2<{
  update: (state: WebsocketState) => void;
  message: (message: BinaryMessage) => void;
  close: (event: CloseEvent) => void;
  open: () => void;
  error: (error: Error) => void;
  reconnect: () => void;
}> {
  #wsLastMessageReceived = 0;
  #shouldConnect = true;
  #heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  #checkInterval: ReturnType<typeof setInterval> | null = null;
  #reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  #url: string;
  #protocols: string[];
  #state: WebsocketState = { type: "offline", ws: null };
  #reconnectAttempt = 0;
  #transports: TransformStream<BinaryMessage, BinaryMessage>[] = [];
  /**
   * Given a single writer (the incoming websocket messages), this will fan out to all connected readers
   */
  #fanOutWriter = createFanOutWriter();
  /**
   * A writable stream to send messages over the websocket connection
   */
  public writable: WritableStream<BinaryMessage> = new WritableStream({
    write: (message) => {
      this.send(message);
    },
  });
  /**
   * Whether the websocket connection has been destroyed
   */
  public isDestroyed = false;

  /**
   * @returns a promise that resolves when the websocket is connected
   */
  public get connected(): Promise<void> {
    switch (this.state.type) {
      case "offline":
      case "connecting": {
        return new Promise((resolve, reject) => {
          let handled = false;
          this.once("close", () => {
            if (!handled) {
              handled = true;
              reject(new Error("WebSocket closed"));
            }
          });
          this.once("open", () => {
            if (!handled) {
              handled = true;
              resolve();
            }
          });
        });
      }
      case "connected": {
        return Promise.resolve();
      }

      default: {
        return Promise.reject(
          new Error(`WebSocket is in an invalid state: ${this.state.type}`),
        );
      }
    }
  }

  public get state() {
    return this.#state;
  }

  public set state(state: WebsocketState) {
    this.#state = state;
    this.emit("update", [state]);
    switch (state.type) {
      case "error": {
        this.emit("error", [state.error]);
        break;
      }
      case "connected": {
        if (this.#reconnectAttempt > 0) {
          this.#reconnectAttempt = 0;
          this.emit("reconnect", []);
        }
        this.emit("open", []);
        break;
      }
    }
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
      this.connect();
    }

    this.#setupHeartbeat();
    this.#setupConnectionCheck();
  }

  #setupHeartbeat() {
    this.#heartbeatInterval = setInterval(() => {
      if (this.state.type === "connected") {
        this.send(encodePingMessage());
      }
    }, HEARTBEAT_INTERVAL);
  }

  #setupConnectionCheck() {
    this.#checkInterval = setInterval(() => {
      if (
        this.state.type === "connected" &&
        MESSAGE_RECONNECT_TIMEOUT < Date.now() - this.#wsLastMessageReceived
      ) {
        this.#handleConnectionTimeout();
      }
    }, MESSAGE_RECONNECT_TIMEOUT / 10);
  }

  #handleConnectionTimeout() {
    const error = new Error(
      "WebSocket connection timeout - no messages received",
    );
    this.state = {
      type: "error",
      ws: this.state.ws,
      error,
      reconnectAttempt: this.#reconnectAttempt,
    };
    this.#closeWebSocketConnection();
  }

  private _setupWebSocket() {
    if (this.isDestroyed) {
      throw new Error("WebsocketClient is destroyed, create a new instance");
    }
    if (!this.#shouldConnect) {
      return;
    }

    try {
      const websocket = new WebSocket(this.#url, this.#protocols);
      websocket.binaryType = "arraybuffer";
      this.state = { type: "connecting", ws: websocket };

      websocket.onmessage = async (event) => {
        this.#wsLastMessageReceived = Date.now();
        const message = new Uint8Array(
          event.data as ArrayBuffer,
        ) as BinaryMessage;

        if (isPongMessage(message)) {
          return;
        }

        const writer = this.#fanOutWriter.writable.getWriter();
        await writer.write(message);
        writer.releaseLock();
        this.emit("message", [message]);
      };

      websocket.onerror = (event) => {
        const error = new Error("WebSocket error", { cause: event });
        this.state = {
          type: "error",
          ws: websocket,
          error,
          reconnectAttempt: this.#reconnectAttempt,
        };
      };

      websocket.onclose = (event) => {
        this.#closeWebSocketConnection();
        this.emit("close", [event]);
      };

      websocket.onopen = () => {
        this.#wsLastMessageReceived = Date.now();
        this.state = { type: "connected", ws: websocket };
      };
    } catch (error) {
      this.state = {
        type: "error",
        ws: null,
        error: error instanceof Error ? error : new Error(String(error)),
        reconnectAttempt: this.#reconnectAttempt,
      };
      this.#scheduleReconnect();
    }
  }

  #scheduleReconnect() {
    if (this.#reconnectTimeout) {
      clearTimeout(this.#reconnectTimeout);
    }

    if (!this.#shouldConnect || this.isDestroyed) {
      return;
    }

    const delay = Math.min(
      INITIAL_RECONNECT_DELAY * Math.pow(2, this.#reconnectAttempt),
      MAX_BACKOFF_TIME,
    );

    this.#reconnectTimeout = setTimeout(() => {
      if (this.#reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
        this.state = {
          type: "error",
          ws: null,
          error: new Error("Maximum reconnection attempts reached"),
          reconnectAttempt: this.#reconnectAttempt,
        };
        return;
      }

      this.#reconnectAttempt++;
      this._setupWebSocket();
    }, delay);
  }

  #closeWebSocketConnection() {
    if (this.state.ws) {
      this.state.ws.close();
      const wasConnected = this.state.type === "connected";
      this.state = { type: "offline", ws: null };

      if (wasConnected) {
        this.#scheduleReconnect();
      }
    }
  }

  public send(data: BinaryMessage) {
    if (this.isDestroyed) {
      throw new Error("WebsocketClient is destroyed, create a new instance");
    }
    // TODO should their be queueing of unsent messages?
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

    if (this.#heartbeatInterval) {
      clearInterval(this.#heartbeatInterval);
    }
    if (this.#checkInterval) {
      clearInterval(this.#checkInterval);
    }
    if (this.#reconnectTimeout) {
      clearTimeout(this.#reconnectTimeout);
    }

    this.#shouldConnect = false;
    if (this.state.ws) {
      this.#closeWebSocketConnection();
    }
  }

  [Symbol.dispose]() {
    this.destroy();
  }

  /**
   * Manually connect to the websocket connection
   */
  public connect() {
    if (this.isDestroyed) {
      throw new Error("WebsocketClient is destroyed, create a new instance");
    }
    this.#shouldConnect = true;
    this.#reconnectAttempt = 0;
    if (this.state.type === "offline") {
      this._setupWebSocket();
    }
  }

  /**
   * Manually disconnect from the websocket connection
   */
  public disconnect() {
    if (this.isDestroyed) {
      throw new Error("WebsocketClient is destroyed, create a new instance");
    }
    this.#shouldConnect = false;
    if (this.#reconnectTimeout) {
      clearTimeout(this.#reconnectTimeout);
    }
    if (this.state.ws) {
      this.#closeWebSocketConnection();
    }
  }

  /**
   * Get a new reader to read incoming messages from the websocket connection
   */
  public getReader() {
    return this.#fanOutWriter.getReader();
  }
}
