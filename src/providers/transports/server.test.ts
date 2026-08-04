import { beforeEach, describe, expect, it } from "bun:test";
import type { Message, RawReceivedMessage, ServerContext } from "teleportal";
import { DocMessage, InMemoryPubSub } from "teleportal";
import { getEmptyStateVector } from "teleportal/protocol";
import { Server } from "teleportal/server";
import { MemoryDocumentStorage } from "teleportal/storage";
import { defaultTimer } from "../utils";
import { serverTransport } from "./server";
import type { TransportConnectContext } from "./types";

/** Poll until `condition` holds (event-driven wait, no fixed sleeps). */
async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((r) => setTimeout(r, 1));
  }
}

const ctx = (overrides: Partial<ServerContext> = {}): ServerContext => ({
  clientId: "st-client",
  userId: "st-user",
  room: "st-room",
  ...overrides,
});

function makeConnectCtx(
  overrides: Partial<TransportConnectContext> = {},
): TransportConnectContext & { closes: Array<Error | undefined>; received: RawReceivedMessage[] } {
  const closes: Array<Error | undefined> = [];
  const received: RawReceivedMessage[] = [];
  return {
    onMessage: (m) => received.push(m),
    onClose: (e) => closes.push(e),
    onPing: () => {},
    timer: defaultTimer,
    closes,
    received,
    ...overrides,
  };
}

describe("serverTransport", () => {
  let server: Server<ServerContext>;
  let pubSub: InMemoryPubSub;

  beforeEach(() => {
    pubSub = new InMemoryPubSub();
    MemoryDocumentStorage.docs.clear();
    MemoryDocumentStorage.pendingUpdates.clear();
    server = new Server({
      storage: () => Promise.resolve(new MemoryDocumentStorage()),
      pubSub,
    });
  });

  it("stamps authenticated context while preserving message identity", async () => {
    const transport = serverTransport(server, {
      context: ctx({ clientId: "auth-client", userId: "auth-user", room: "auth-room" }),
    });
    await transport.connect(makeConnectCtx());

    // A client-owned message with a spoofed / different context.
    const original = new DocMessage<ServerContext>(
      "doc-1",
      { type: "sync-step-1", sv: getEmptyStateVector() },
      { clientId: "spoofed", userId: "spoofed", room: "spoofed" },
    );
    // `.id`/`.encoded` are derived before send and must stay stable so the
    // connection's in-flight tracking (keyed by `.id`) still resolves.
    const originalId = original.id;

    await transport.send(original);

    // The authenticated identity overrides the spoof (the transport is the
    // trust boundary).
    expect(original.context).toEqual({
      clientId: "auth-client",
      userId: "auth-user",
      room: "auth-room",
    });
    // Identity is unchanged: context is not part of the wire encoding.
    expect(original.id).toBe(originalId);

    await transport.close();
  });

  it("delivers a real Message instance (not a plain object) to the server", async () => {
    // Intercept the transport the server would consume so we can inspect what
    // actually lands server-side. The connection layer and the server's
    // consume path both rely on the message still being a `Message` instance
    // (prototype getters `.encoded`/`.id`, `.type`); a naive spread would strip
    // the prototype and yield a plain object that breaks encoding.
    let serverSource: AsyncIterable<Message<ServerContext>[]> | null = null;
    const originalCreateClient = server.createClient.bind(server);
    server.createClient = ((args: Parameters<typeof server.createClient>[0]) => {
      serverSource = args.transport.source as AsyncIterable<Message<ServerContext>[]>;
      // Do NOT hand the source to the real consume loop — we drain it here.
      return { id: args.id ?? "x" } as ReturnType<typeof server.createClient>;
    }) as typeof server.createClient;

    const transport = serverTransport(server, {
      context: ctx({ clientId: "auth-client", userId: "auth-user", room: "auth-room" }),
    });
    await transport.connect(makeConnectCtx());

    const original = new DocMessage<ServerContext>(
      "doc-1",
      { type: "sync-step-1", sv: getEmptyStateVector() },
      { clientId: "spoofed", userId: "spoofed", room: "spoofed" },
    );
    await transport.send(original);

    expect(serverSource).not.toBeNull();
    const iterator = serverSource![Symbol.asyncIterator]();
    const { value: batch } = await iterator.next();
    const delivered = batch![0];

    // Still a real DocMessage with a working prototype.
    expect(delivered).toBeInstanceOf(DocMessage);
    expect(delivered.type).toBe("doc");
    expect(() => delivered.encoded).not.toThrow();
    expect(typeof delivered.id).toBe("string");
    // Context was stamped with the authenticated identity, overriding the spoof.
    expect(delivered.context).toEqual({
      clientId: "auth-client",
      userId: "auth-user",
      room: "auth-room",
    });

    server.createClient = originalCreateClient;
  });

  it("fires ctx.onClose when the server tears the client down", async () => {
    const connectCtx = makeConnectCtx();
    const transport = serverTransport(server, {
      context: ctx({ clientId: "srv-close" }),
    });
    await transport.connect(connectCtx);

    // Server-initiated teardown: the consume loop's finally calls the
    // server-side transport.close(), which must surface as onClose so the
    // client-facing connection stops believing it is connected.
    server.disconnectClient("srv-close", "stream-ended");

    await waitFor(() => connectCtx.closes.length > 0);
    expect(connectCtx.closes.length).toBeGreaterThan(0);

    await transport.close();
  });

  it("does not fire ctx.onClose when the client closes the transport", async () => {
    const connectCtx = makeConnectCtx();
    const transport = serverTransport(server, {
      context: ctx({ clientId: "cli-close" }),
    });
    await transport.connect(connectCtx);

    // Client-initiated close: the connection already knows, so re-notifying it
    // would be spurious.
    await transport.close();

    // Give any stray async close a tick to land.
    await new Promise((r) => setTimeout(r, 5));
    expect(connectCtx.closes.length).toBe(0);
  });
});
