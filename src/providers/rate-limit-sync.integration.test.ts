import { describe, expect, it } from "bun:test";
import * as Y from "yjs";
import type { Message, ServerContext, Transport } from "teleportal";
import { createEncryptionKey } from "teleportal/encryption-key";
import { createChannel } from "../lib/iter";
import { Server } from "../server/server";
import { MemoryDocumentStorage } from "../storage/in-memory/document-storage";
import type { RateLimitState, RateLimitStorage } from "../storage/types";
import { defaultRateLimitRules } from "../transports/rate-limiter";
import { DirectConnection } from "./connection";
import { Provider } from "./provider";
import { createMemoryTransportPair } from "./transports/memory";

const DOC = "enc-doc";

function tick(ms = 1) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/** Poll until `condition` holds (event-driven wait, no fixed sleeps). */
async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await tick();
  }
}

class MapRateLimitStorage implements RateLimitStorage {
  store = new Map<string, RateLimitState>();
  async getState(key: string) {
    return this.store.get(key) || null;
  }
  async setState(key: string, state: RateLimitState, _ttl: number) {
    this.store.set(key, state);
  }
  async deleteState(key: string) {
    this.store.delete(key);
  }
  async hasState(key: string) {
    return this.store.has(key);
  }
  async transaction<T>(_key: string, cb: () => Promise<T>) {
    return cb();
  }
}

/**
 * Bridge a memory transport pair into `server.createClient` — the same role
 * the websocket server plays in production (including the authenticated
 * context attachment), so messages flow through the REAL rate-limited and
 * validated transport chain.
 */
async function connectClient(server: Server<ServerContext>, clientId: string, userId: string) {
  const [clientTransport, serverTransport] = createMemoryTransportPair();
  const ch = createChannel<Message<ServerContext>>();
  // Teardown races are inherent here (as with a real socket): the client may
  // deliver a message after the server ended the consume loop and closed the
  // channel — drop it like a closed socket would.
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    ch.close();
  };
  await serverTransport.connect({
    onMessage: (raw) => {
      if (closed) return;
      const msg = raw as Message<ServerContext>;
      Object.assign(msg.context, { clientId, userId, room: "room" });
      ch.send(msg);
    },
    onClose: close,
    onPing: () => {},
    timer: {
      setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
      clearTimeout: (id: unknown) => clearTimeout(id as number),
      setInterval: (cb: () => void, ms: number) => setInterval(cb, ms),
      clearInterval: (id: unknown) => clearInterval(id as number),
    } as never,
  });
  const transport: Transport<ServerContext> = {
    source: ch as AsyncIterable<Message<ServerContext>[]>,
    write: async (msg) => {
      await serverTransport.send(msg);
    },
    close,
  };
  server.createClient({ transport, id: clientId });
  const conn = new DirectConnection({ transports: [clientTransport], connect: false });
  await conn.connect();
  return conn;
}

describe("rate-limited sync during sustained typing (integration)", () => {
  it("delivers an encrypted fast typist's edits to peers WHILE typing continues", async () => {
    // Regression for the burst-stall: peers used to see nothing until the
    // typist went idle, because a rate-limit drop + solo NACK retransmit
    // starved behind the typist's own fresh sends while the server parked
    // every causally-later update on the missing one. Uses the playground's
    // exact defaults (defaultRateLimitRules + shared storage) on an
    // ENCRYPTED document.
    const documentStorage = new MemoryDocumentStorage();
    const server = new Server<ServerContext>({
      storage: async () => documentStorage,
      rateLimitConfig: {
        rules: defaultRateLimitRules(),
        rateLimitStorage: new MapRateLimitStorage(),
        getUserId: (m) => m.context?.userId,
        getDocumentId: (m) => m.document,
      },
    });

    const key = await createEncryptionKey();
    const connA = await connectClient(server, "client-a", "alice");
    const connB = await connectClient(server, "client-b", "bob");
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const providerA = new Provider({
      connection: connA,
      document: DOC,
      enableOfflinePersistence: false,
      rpc: {},
      ydoc: docA,
      encryptionKey: key,
    });
    const providerB = new Provider({
      connection: connB,
      document: DOC,
      enableOfflinePersistence: false,
      rpc: {},
      ydoc: docB,
      encryptionKey: key,
    });
    await Promise.all([providerA.synced, providerB.synced]);

    // Mash the keyboard: 60 chars at ~5ms apart (~200 chars/s) — far beyond
    // any human typing speed, spanning several 100ms client batch flushes.
    const textA = docA.getText("t");
    for (let i = 0; i < 60; i++) {
      textA.insert(textA.length, "x");
      await tick(5);
    }
    const lengthSeenByBWhileTyping = docB.getText("t").length;

    // Everything converges shortly after the burst...
    await waitFor(() => docB.getText("t").length === 60);
    // ...and crucially B was receiving content DURING the burst, not only
    // after the typist stopped.
    expect(lengthSeenByBWhileTyping).toBeGreaterThan(0);

    providerA.destroy();
    providerB.destroy();
    await server[Symbol.asyncDispose]();
  });
});
