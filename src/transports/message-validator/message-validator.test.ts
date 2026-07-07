import { describe, expect, it } from "bun:test";
import { DocMessage, type Message, type StateVector } from "teleportal";
import { createChannel } from "../../lib/iter";
import { withMessageValidator, withMessageValidatorSink, withMessageValidatorSource } from ".";

function makeMsg(id: string): Message<{ clientId: string }> {
  return new DocMessage(
    "doc",
    { type: "sync-step-1", sv: new Uint8Array([0]) as StateVector },
    { clientId: id },
  );
}

describe("withMessageValidatorSink", () => {
  it("passes all messages through when no isAuthorized is provided", async () => {
    const written: Message[] = [];
    const sink = withMessageValidatorSink({ write: (msg) => void written.push(msg), close() {} });

    await sink.write(makeMsg("a"));
    await sink.write(makeMsg("b"));

    expect(written).toHaveLength(2);
  });

  it("blocks messages when isAuthorized returns false", async () => {
    const written: Message[] = [];
    const sink = withMessageValidatorSink(
      { write: (msg) => void written.push(msg), close() {} },
      { isAuthorized: async () => false },
    );

    await sink.write(makeMsg("a"));
    expect(written).toHaveLength(0);
  });

  it("allows messages when isAuthorized returns true", async () => {
    const written: Message[] = [];
    const sink = withMessageValidatorSink(
      { write: (msg) => void written.push(msg), close() {} },
      { isAuthorized: async () => true },
    );

    await sink.write(makeMsg("a"));
    expect(written).toHaveLength(1);
  });
});

describe("withMessageValidatorSource", () => {
  it("passes all messages through when no isAuthorized is provided", async () => {
    const ch = createChannel<Message<{ clientId: string }>>();
    const source = withMessageValidatorSource({ source: ch });

    ch.send(makeMsg("a"));
    ch.close();

    const received: Message[] = [];
    for await (const batch of source.source) {
      for (const msg of batch) received.push(msg);
    }
    expect(received).toHaveLength(1);
  });

  it("filters messages based on isAuthorized", async () => {
    const ch = createChannel<Message<{ clientId: string }>>();
    const source = withMessageValidatorSource(
      { source: ch },
      {
        isAuthorized: async (msg) => msg.context.clientId === "allowed",
      },
    );

    ch.send(makeMsg("allowed"));
    ch.send(makeMsg("denied"));
    ch.send(makeMsg("allowed"));
    ch.close();

    const received: Message[] = [];
    for await (const batch of source.source) {
      for (const msg of batch) received.push(msg);
    }
    expect(received).toHaveLength(2);
    expect(received.every((m) => m.context.clientId === "allowed")).toBe(true);
  });
});

describe("withMessageValidator", () => {
  it("applies authorization to both read and write", async () => {
    const ch = createChannel<Message<{ clientId: string }>>();
    const written: Message[] = [];

    const transport = withMessageValidator(
      {
        source: ch,
        write: (msg) => void written.push(msg),
        close() {},
      },
      {
        isAuthorized: async (msg, type) => {
          if (type === "write") return msg.context.clientId === "writer";
          return msg.context.clientId === "reader";
        },
      },
    );

    await transport.write(makeMsg("writer"));
    await transport.write(makeMsg("blocked"));
    expect(written).toHaveLength(1);

    ch.send(makeMsg("reader"));
    ch.send(makeMsg("blocked"));
    ch.close();

    const received: Message[] = [];
    for await (const batch of transport.source) {
      for (const msg of batch) received.push(msg);
    }
    expect(received).toHaveLength(1);
    expect(received[0].context.clientId).toBe("reader");
  });
});
