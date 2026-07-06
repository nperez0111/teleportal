import { describe, expect, it } from "bun:test";
import { DocMessage } from "teleportal";
import { getSSESink } from "./index";

describe("getSSESink", () => {
  const context = { clientId: "client-1", userId: "user", room: "room" };

  // Cloudflare workerd rejects string chunks in Response bodies, so the SSE
  // stream must emit the UTF-8 bytes of each frame rather than the string.
  it("enqueues Uint8Array chunks into the SSE response body", async () => {
    const sink = getSSESink({ context });
    const reader = sink.sseResponse.body!.getReader();

    const { value } = await reader.read();
    expect(value).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(value)).toContain("event:client-id");

    sink.close();
  });

  it("encodes written messages as Uint8Array SSE frames", async () => {
    const sink = getSSESink({ context });
    const reader = sink.sseResponse.body!.getReader();
    await reader.read(); // consume the client-id frame

    const message = new DocMessage("doc", { type: "sync-done" }, context);
    await sink.write(message);

    const { value } = await reader.read();
    expect(value).toBeInstanceOf(Uint8Array);
    const text = new TextDecoder().decode(value);
    expect(text).toContain("event:message");
    expect(text).toContain(`id:${message.id}`);

    sink.close();
  });
});
