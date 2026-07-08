import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { EventSource } from "eventsource";

import {
  type ConnectionTransport,
  httpTransport,
  Provider,
  websocketTransport,
} from "teleportal/providers";

/**
 * Integration test against real workerd: spawns `wrangler dev` (runs fully
 * offline — the workerd binary ships with the wrangler dependency) and
 * exercises the example end to end.
 */
const PORT = 8790;
const BASE = `http://localhost:${PORT}`;
const URL_ = `${BASE}/api`;
const PERSIST_DIR = `${import.meta.dir}/../.wrangler/integration-test-state`;

let wranglerDev: ReturnType<typeof Bun.spawn> | undefined;

async function waitForHealthy(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      throw new Error("wrangler dev did not become ready in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

beforeAll(async () => {
  rmSync(PERSIST_DIR, { recursive: true, force: true });
  wranglerDev = Bun.spawn(
    [
      "bun",
      "x",
      "wrangler",
      "dev",
      "--port",
      String(PORT),
      "--inspector-port",
      "0",
      "--persist-to",
      PERSIST_DIR,
    ],
    {
      cwd: import.meta.dir + "/..",
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  await waitForHealthy(60_000);
}, 90_000);

afterAll(() => {
  wranglerDev?.kill();
  rmSync(PERSIST_DIR, { recursive: true, force: true });
});

describe("teleportal on workerd", () => {
  it("serves SSE as a binary event-stream with a client-id frame", async () => {
    const res = await fetch(`${BASE}/api/sse`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain("event:client-id");
    expect(text).toContain(res.headers.get("x-teleportal-client-id")!);
    await reader.cancel();
  }, 30_000);

  const roundTrip = (name: string, transports: ConnectionTransport[]) =>
    it(`syncs and persists a document over ${name}`, async () => {
      const docName = `it-${name}-${crypto.randomUUID()}`;

      const writer = await Provider.create({
        url: URL_,
        document: docName,
        transports,
        encryptionKey: false,
      });
      writer.doc.getText("t").insert(0, `hello via ${name}`);
      await writer.synced;
      await writer.flush();
      await writer.destroy();

      const reader = await Provider.create({
        url: URL_,
        document: docName,
        transports,
        encryptionKey: false,
      });
      await reader.synced;
      const text = reader.doc.getText("t").toString();
      await reader.destroy();

      expect(text).toBe(`hello via ${name}`);
    }, 30_000);

  roundTrip("websocket", [websocketTransport({ timeout: 5000 })]);
  roundTrip("sse", [httpTransport({ EventSource })]);
});
