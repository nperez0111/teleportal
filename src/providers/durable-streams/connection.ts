import {
  decodeMessageArray,
  encodeMessageArray,
  type Message,
  type RawReceivedMessage,
} from "teleportal";
import { Connection, type ConnectionOptions } from "../connection";

export type DurableStreamsConnectContext = {
  connected: {
    clientId: string;
    offset: string;
    cursor: string | null;
  };
  disconnected: {
    clientId: string | null;
    offset: string | null;
    cursor: string | null;
  };
  connecting: {
    clientId: string | null;
    offset: string | null;
    cursor: string | null;
  };
  errored: {
    clientId: string | null;
    offset: string | null;
    cursor: string | null;
    reconnectAttempt: number;
  };
};

export type DurableStreamsConnectionOptions = {
  /**
   * Base URL for the server (e.g. http://localhost:1234)
   */
  url: string;
  /**
   * Fetch implementation to use.
   */
  fetch?: typeof fetch;
  /**
   * Durable streams base path.
   *
   * @default "/v1/stream"
   */
  basePath?: string;
  /**
   * Stream key prefix for Teleportal.
   *
   * @default "teleportal"
   */
  prefix?: string;
} & Omit<ConnectionOptions, "heartbeatInterval">;

function randomId(): string {
  // Prefer crypto.randomUUID if available.
  if (globalThis.crypto && "randomUUID" in globalThis.crypto) {
    return (globalThis.crypto as any).randomUUID();
  }
  // Fallback: timestamp + random.
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

export class DurableStreamsConnection extends Connection<DurableStreamsConnectContext> {
  #url: string;
  #fetch: typeof fetch;
  #basePath: string;
  #prefix: string;

  #clientId: string | null = null;
  #offset: string = "-1";
  #cursor: string | null = null;

  #receiveAbort: AbortController | null = null;
  #initInProgress: Promise<void> | null = null;

  constructor(options: DurableStreamsConnectionOptions) {
    super(options);
    this.#url = options.url;
    this.#fetch = options.fetch ?? fetch.bind(globalThis);
    this.#basePath = options.basePath ?? "/v1/stream";
    this.#prefix = options.prefix ?? "teleportal";

    this._state = {
      type: "disconnected",
      context: { clientId: null, offset: null, cursor: null },
    };
  }

  #streamUrl(kind: "in" | "out"): string {
    const base = new URL(this.#url);
    const path = this.#basePath.endsWith("/")
      ? this.#basePath.slice(0, -1)
      : this.#basePath;
    const key = `${this.#prefix}/${kind}/${this.#clientId}`;
    base.pathname = `${path}/${key}`;
    return base.toString();
  }

  async #putEnsure(url: string): Promise<void> {
    const resp = await this.#fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array() as unknown as BodyInit,
      cache: "no-store",
    });
    if (!resp.ok) {
      throw new Error(`Failed to create/ensure stream: ${resp.status} ${resp.statusText}`);
    }
  }

  protected async initConnection(): Promise<void> {
    if (this.#initInProgress) return this.#initInProgress;
    if (this.destroyed) {
      throw new Error(
        "DurableStreamsConnection is destroyed, create a new instance",
      );
    }
    if (!this.shouldAttemptConnection()) return;
    if (this.state.type === "connected" || this.state.type === "connecting") return;

    this.#initInProgress = (async () => {
      await this.#cleanupReceiveLoop();

      this.setState({
        type: "connecting",
        context: {
          clientId: this.#clientId,
          offset: this.#clientId ? this.#offset : null,
          cursor: this.#cursor,
        },
      });

      this.#clientId = this.#clientId ?? randomId();
      this.#offset = "-1";
      this.#cursor = null;

      // Ensure streams exist.
      await this.#putEnsure(this.#streamUrl("in"));
      await this.#putEnsure(this.#streamUrl("out"));

      // Start receive loop.
      this.#receiveAbort = new AbortController();
      const signal = this.#receiveAbort.signal;

      // Mark connected once receive loop starts.
      this.setState({
        type: "connected",
        context: { clientId: this.#clientId, offset: this.#offset, cursor: this.#cursor },
      });
      this.updateLastMessageReceived();

      this.#receiveLoop({ signal }).catch((error_) => {
        if (!this.destroyed && !signal.aborted) {
          this.handleConnectionError(
            error_ instanceof Error ? error_ : new Error(String(error_)),
          );
        }
      });
    })();

    try {
      await this.#initInProgress;
    } finally {
      this.#initInProgress = null;
    }
  }

  async #receiveLoop({ signal }: { signal: AbortSignal }) {
    const outUrl = this.#streamUrl("out");

    while (!signal.aborted && !this.destroyed) {
      const u = new URL(outUrl);
      // Lexicographic query parameter ordering (per spec guidance).
      u.searchParams.set("live", "long-poll");
      u.searchParams.set("offset", this.#offset);
      if (this.#cursor) {
        u.searchParams.set("cursor", this.#cursor);
      }

      const resp = await this.#fetch(u.toString(), {
        method: "GET",
        cache: "no-store",
        signal,
      });

      if (signal.aborted) return;

      if (resp.status === 204) {
        const next = resp.headers.get("Stream-Next-Offset");
        const cursor = resp.headers.get("Stream-Cursor");
        if (next) this.#offset = next;
        if (cursor) this.#cursor = cursor;
        this.setState({
          type: "connected",
          context: { clientId: this.#clientId!, offset: this.#offset, cursor: this.#cursor },
        });
        continue;
      }

      if (!resp.ok) {
        throw new Error(
          `Durable stream read failed: ${resp.status} ${resp.statusText}`,
        );
      }

      const next = resp.headers.get("Stream-Next-Offset");
      const cursor = resp.headers.get("Stream-Cursor");
      const bytes = new Uint8Array(await resp.arrayBuffer());

      if (next) this.#offset = next;
      if (cursor) this.#cursor = cursor;

      if (bytes.byteLength > 0) {
        const messages = decodeMessageArray(bytes as any) as RawReceivedMessage[];
        for (const msg of messages) {
          this.updateLastMessageReceived();
          await this.writer.write(msg);
          this.call("message", msg as any);
        }
      }

      this.setState({
        type: "connected",
        context: { clientId: this.#clientId!, offset: this.#offset, cursor: this.#cursor },
      });
    }
  }

  protected async sendMessage(message: Message): Promise<void> {
    if (this.state.type !== "connected" || !this.#clientId) {
      throw new Error("Not connected - message should be buffered");
    }

    const inUrl = this.#streamUrl("in");
    const body = encodeMessageArray([message as any]) as unknown as Uint8Array;
    const resp = await this.#fetch(inUrl, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      cache: "no-store",
      body: body as unknown as BodyInit,
    });
    if (!resp.ok && resp.status !== 204) {
      throw new Error(
        `Durable stream append failed: ${resp.status} ${resp.statusText}`,
      );
    }
  }

  async #cleanupReceiveLoop(): Promise<void> {
    if (this.#receiveAbort) {
      this.#receiveAbort.abort("cleanup");
      this.#receiveAbort = null;
    }
  }

  protected async closeConnection(): Promise<void> {
    await this.#cleanupReceiveLoop();
    this.setState({
      type: "disconnected",
      context: { clientId: this.#clientId, offset: this.#offset, cursor: this.#cursor },
    });
  }

  public async destroy(): Promise<void> {
    if (this.destroyed) return;
    await this.#cleanupReceiveLoop();
    await super.destroy();
  }
}

