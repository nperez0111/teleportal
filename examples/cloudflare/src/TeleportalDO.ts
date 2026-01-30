/// <reference types="@cloudflare/workers-types" />
import { DurableObject } from "cloudflare:workers";
import crossws from "crossws/adapters/cloudflare";
import { createStorage } from "unstorage";
import cloudflareKVBinding from "unstorage/drivers/cloudflare-kv-binding";
import { getHTTPHandlers } from "teleportal/http";
import { Server } from "teleportal/server";
import { UnstorageDocumentStorage } from "teleportal/storage";
import { getWebsocketHandlers } from "teleportal/websocket-server";

const FALLBACK_HTML_URL =
  "https://raw.githubusercontent.com/nperez0111/teleportal/refs/heads/main/examples/simple/index.html";

interface Env {
  TELEPORTAL_STORAGE: KVNamespace;
}

export class TeleportalDO extends DurableObject<Env> {
  private httpHandler: (req: Request) => Response | Promise<Response>;
  private ws: ReturnType<typeof crossws>;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);

    const backingStorage = createStorage({
      driver: cloudflareKVBinding({ binding: env.TELEPORTAL_STORAGE }),
    });

    const server = new Server({
      storage: async () =>
        new UnstorageDocumentStorage(backingStorage, {
          keyPrefix: "document",
          scanKeys: false,
        }),
    });

    const wsHandlers = getWebsocketHandlers({
      server,
      onUpgrade: async () => ({
        context: { userId: "user", room: "docs" },
      }),
    });

    // Cast needed: getWebsocketHandlers returns teleportal's crossws.Hooks; adapter expects same shape but from its own crossws package
    this.ws = crossws({ hooks: wsHandlers as any });
    this.ws.handleDurableInit(this, state, env);

    this.httpHandler = getHTTPHandlers({
      server,
      getContext: () => ({ userId: "user", room: "docs" }),
      fetch: async () => {
        const res = await fetch(FALLBACK_HTML_URL);
        return new Response(await res.text(), {
          headers: { "Content-Type": "text/html" },
        });
      },
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") === "websocket") {
      return this.ws.handleDurableUpgrade(this, request);
    }
    return this.httpHandler(request);
  }

  async webSocketMessage(
    client: WebSocket,
    message: ArrayBuffer | string,
  ): Promise<void> {
    await this.ws.handleDurableMessage(this, client, message);
  }

  async webSocketClose(
    client: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void> {
    await this.ws.handleDurableClose(this, client, code, reason, wasClean);
  }

  async webSocketPublish(
    topic: string,
    message: unknown,
    opts?: { exclude?: unknown },
  ): Promise<void> {
    await this.ws.handleDurablePublish(this, topic, message, opts);
  }
}
