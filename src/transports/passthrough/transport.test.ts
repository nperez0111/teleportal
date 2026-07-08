import { describe, expect, it } from "bun:test";

import {
  AwarenessMessage,
  DocMessage,
  SyncStep2Update,
  type AwarenessUpdateMessage,
  type Message,
  type Sink,
  type StateVector,
  type Update,
  type VersionedUpdate,
  type VersionedSyncStep2Update,
} from "teleportal";
import { createChannel } from "../../lib/iter";
import { noopTransport, withPassthrough, withPassthroughSink } from ".";

export function generateTestTransport(type: "doc" | "awareness"): {
  source: AsyncIterable<Message<{ test: string }>[]>;
  write: (message: Message<{ test: string }>) => void;
  close: () => void;
} {
  const ch = createChannel<Message<{ test: string }>>();

  if (type === "doc") {
    // Push messages asynchronously
    (async () => {
      ch.send(
        new DocMessage(
          "test",
          {
            type: "sync-step-1",
            sv: new Uint8Array([0x00, 0x00, 0x01, 0x02, 0x03]) as StateVector,
          },
          { test: "id-1" },
        ),
      );

      await new Promise((resolve) => setTimeout(resolve, 0));

      ch.send(
        new DocMessage(
          "test",
          {
            type: "sync-step-2",
            update: {
              version: 2,
              data: new Uint8Array([0x01, 0x00, 0x01, 0x02, 0x03]) as SyncStep2Update,
            } as VersionedSyncStep2Update,
          },
          { test: "id-2" },
        ),
      );

      await new Promise((resolve) => setTimeout(resolve, 0));

      ch.send(
        new DocMessage(
          "test",
          {
            type: "update",
            update: {
              version: 2,
              data: new Uint8Array([0x02, 0x00, 0x01, 0x02, 0x03]) as Update,
            } as VersionedUpdate,
          },
          { test: "id-3" },
        ),
      );

      ch.close();
    })();

    return {
      source: ch,
      write() {},
      close() {},
    };
  } else {
    // Push messages asynchronously
    (async () => {
      ch.send(
        new AwarenessMessage(
          "test",
          {
            type: "awareness-update",
            update: new Uint8Array([0x00, 0x01, 0x02, 0x03]) as AwarenessUpdateMessage,
          },
          { test: "id-1" },
        ),
      );

      await new Promise((resolve) => setTimeout(resolve, 0));

      ch.send(
        new AwarenessMessage(
          "test",
          {
            type: "awareness-update",
            update: new Uint8Array([0x00, 0x01, 0x02, 0x03]) as AwarenessUpdateMessage,
          },
          { test: "id-2" },
        ),
      );

      await new Promise((resolve) => setTimeout(resolve, 0));

      ch.send(
        new AwarenessMessage(
          "test",
          {
            type: "awareness-update",
            update: new Uint8Array([0x00, 0x01, 0x02, 0x03]) as AwarenessUpdateMessage,
          },
          { test: "id-3" },
        ),
      );

      ch.close();
    })();

    return {
      source: ch,
      write() {},
      close() {},
    };
  }
}

describe("transport", () => {
  it("can read doc", async () => {
    const transport = generateTestTransport("doc");

    const received: Message<{ test: string }>[] = [];
    for await (const batch of transport.source) {
      for (const chunk of batch) {
        received.push(chunk);
      }
    }

    expect(received.length).toBe(3);
    expect(received[0].context.test).toBe("id-1");
    expect(received[1].context.test).toBe("id-2");
    expect(received[2].context.test).toBe("id-3");
  });

  it("can read awareness", async () => {
    const transport = generateTestTransport("awareness");

    const received: Message<{ test: string }>[] = [];
    for await (const batch of transport.source) {
      for (const chunk of batch) {
        received.push(chunk);
      }
    }

    expect(received.length).toBe(3);
    expect(received[0].context.test).toBe("id-1");
    expect(received[1].context.test).toBe("id-2");
    expect(received[2].context.test).toBe("id-3");
  });

  it("can write doc", async () => {
    let count = 1;
    const transport = withPassthrough(noopTransport(), {
      onWrite(chunk) {
        expect(chunk.context.test).toBe(`id-${count++}`);
      },
    });
    transport.write(
      new DocMessage(
        "test",
        {
          type: "sync-step-1",
          sv: new Uint8Array([0x00, 0x00, 0x01, 0x02, 0x03]) as StateVector,
        },
        { test: "id-1" },
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    transport.write(
      new DocMessage(
        "test",
        {
          type: "sync-step-1",
          sv: new Uint8Array([0x00, 0x00, 0x01, 0x02, 0x03]) as StateVector,
        },
        { test: "id-2" },
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    transport.write(
      new DocMessage(
        "test",
        {
          type: "sync-step-2",
          update: {
            version: 2,
            data: new Uint8Array([0x00, 0x00, 0x01, 0x02, 0x03]) as SyncStep2Update,
          } as VersionedSyncStep2Update,
        },
        { test: "id-3" },
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("can write awareness", async () => {
    let count = 1;
    const transport = withPassthrough(noopTransport(), {
      onWrite(chunk) {
        expect(chunk.context.test).toBe(`id-${count++}`);
      },
    });
    transport.write(
      new AwarenessMessage(
        "test",
        {
          type: "awareness-update",
          update: new Uint8Array([0x00, 0x00, 0x01, 0x02, 0x03]) as AwarenessUpdateMessage,
        },
        { test: "id-1" },
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    transport.write(
      new AwarenessMessage(
        "test",
        {
          type: "awareness-update",
          update: new Uint8Array([0x00, 0x00, 0x01, 0x02, 0x03]) as AwarenessUpdateMessage,
        },
        { test: "id-2" },
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    transport.write(
      new AwarenessMessage(
        "test",
        {
          type: "awareness-update",
          update: new Uint8Array([0x00, 0x00, 0x01, 0x02, 0x03]) as AwarenessUpdateMessage,
        },
        { test: "id-3" },
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("preserves close() when wrapping a class-based sink", () => {
    // A class instance carries `close` on its prototype, not as an own
    // enumerable property, so a naive `{ ...sink }` spread would drop it.
    let closed = false;
    const proto = {
      write(_message: Message<{ test: string }>) {},
      close() {
        closed = true;
      },
    };
    // `sink` has no OWN `write`/`close`; they live on the prototype, exactly
    // like a class instance. A `{ ...sink }` spread would drop them.
    const sink: Sink<{ test: string }> = Object.create(proto);

    const wrapped = withPassthroughSink(sink);
    wrapped.close();

    expect(closed).toBe(true);
  });
});
