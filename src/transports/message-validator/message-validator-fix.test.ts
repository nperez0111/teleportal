import { describe, it, expect } from "bun:test";
import { DocMessage } from "teleportal";
import { withMessageValidator } from "./index";
import { createChannel } from "../../lib/iter";

/**
 * Regression test for the read/write permission bug.
 *
 * The source (messages FROM clients) should be checked with "write" permission,
 * because clients are writing to the server. Previously, the source was incorrectly
 * checked with "read" permission, causing UPDATE messages to be rejected even when
 * the client had write permission.
 */
describe("message-validator: source uses write permission", () => {
  it("allows update messages when client has write permission", async () => {
    const ch = createChannel<DocMessage<{ hasWritePermission: boolean }>>();
    const received: DocMessage<{ hasWritePermission: boolean }>[] = [];

    const transport = withMessageValidator(
      {
        source: ch,
        write: () => Promise.resolve(),
        close() {},
      },
      {
        isAuthorized: async (msg, type) => {
          if (type === "write") {
            return msg.context.hasWritePermission;
          }
          return false;
        },
      },
    );

    // Send an update message from a client WITH write permission
    ch.send(
      new DocMessage(
        "test-doc",
        { type: "update", update: { version: 1, data: new Uint8Array([1, 2, 3]) as any } },
        { hasWritePermission: true },
      ),
    );

    // Send an update message from a client WITHOUT write permission
    ch.send(
      new DocMessage(
        "test-doc",
        { type: "update", update: { version: 1, data: new Uint8Array([4, 5, 6]) as any } },
        { hasWritePermission: false },
      ),
    );

    ch.close();

    for await (const batch of transport.source) {
      for (const msg of batch) received.push(msg as DocMessage<{ hasWritePermission: boolean }>);
    }

    // Only the message with write permission should pass through
    expect(received).toHaveLength(1);
    expect(received[0].context.hasWritePermission).toBe(true);
  });
});
