import { describe, expect, it } from "bun:test";

import type { YAwarenessUpdate, YDocUpdate, YTransport } from "../base";
import {
  type AwarenessUpdateMessage,
  type SyncStep1,
  type SyncStep2,
  type UpdateStep,
  type ReceivedMessage,
  DocMessage,
  AwarenessMessage,
} from "../protocol";
import { noop, passthrough } from "./passthrough";

export function generateTestTransport(
  type: "doc" | "awareness",
): YTransport<{ test: string }, {}> {
  if (type === "doc") {
    return {
      readable: new ReadableStream<ReceivedMessage<{ test: string }>>({
        async start(controller) {
          controller.enqueue(
            new DocMessage(
              "test",
              new Uint8Array([0x00, 0x00, 0x01, 0x02, 0x03]) as SyncStep1,
              { test: "id-1" },
            ),
          );

          await new Promise((resolve) => setTimeout(resolve, 0));

          controller.enqueue(
            new DocMessage(
              "test",
              new Uint8Array([0x01, 0x00, 0x01, 0x02, 0x03]) as SyncStep2,
              { test: "id-2" },
            ),
          );

          await new Promise((resolve) => setTimeout(resolve, 0));

          controller.enqueue(
            new DocMessage(
              "test",
              new Uint8Array([0x02, 0x00, 0x01, 0x02, 0x03]) as UpdateStep,
              { test: "id-3" },
            ),
          );

          controller.close();
        },
      }),
      writable: new WritableStream<ReceivedMessage<{ test: string }>>(),
    };
  } else {
    return {
      writable: new WritableStream<ReceivedMessage<{ test: string }>>(),
      readable: new ReadableStream<YAwarenessUpdate<{ test: string }>>({
        async start(controller) {
          controller.enqueue(
            new AwarenessMessage(
              "test",
              new Uint8Array([
                0x00, 0x01, 0x02, 0x03,
              ]) as AwarenessUpdateMessage,
              { test: "id-1" },
            ),
          );

          await new Promise((resolve) => setTimeout(resolve, 0));

          controller.enqueue(
            new AwarenessMessage(
              "test",
              new Uint8Array([
                0x00, 0x01, 0x02, 0x03,
              ]) as AwarenessUpdateMessage,
              { test: "id-2" },
            ),
          );

          await new Promise((resolve) => setTimeout(resolve, 0));

          controller.enqueue(
            new AwarenessMessage(
              "test",
              new Uint8Array([
                0x00, 0x01, 0x02, 0x03,
              ]) as AwarenessUpdateMessage,
              { test: "id-3" },
            ),
          );

          controller.close();
        },
      }),
    };
  }
}

describe("transport", () => {
  it("can read doc", async () => {
    const transport = generateTestTransport("doc");

    let count = 1;
    await transport.readable.pipeTo(
      new WritableStream({
        write(chunk) {
          expect(chunk.context.test).toBe(`id-${count++}`);
        },
      }),
    );
  });

  it("can read awareness", async () => {
    const transport = generateTestTransport("awareness");

    let count = 1;
    await transport.readable.pipeTo(
      new WritableStream({
        write(chunk) {
          expect(chunk.context.test).toBe(`id-${count++}`);
        },
      }),
    );
  });

  it("can write doc", async () => {
    let count = 1;
    const transport = passthrough(noop(), {
      onWrite(chunk) {
        expect(chunk.context.test).toBe(`id-${count++}`);
      },
    });
    const writer = transport.writable.getWriter();
    writer.write(
      new DocMessage(
        "test",
        new Uint8Array([0x00, 0x00, 0x01, 0x02, 0x03]) as SyncStep1,
        { test: "id-1" },
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    writer.write(
      new DocMessage(
        "test",
        new Uint8Array([0x00, 0x00, 0x01, 0x02, 0x03]) as SyncStep1,
        { test: "id-2" },
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    writer.write(
      new DocMessage(
        "test",
        new Uint8Array([0x00, 0x00, 0x01, 0x02, 0x03]) as SyncStep1,
        { test: "id-3" },
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    writer.close();
  });
  it("can write awareness", async () => {
    let count = 1;
    const transport = passthrough(noop(), {
      onWrite(chunk) {
        expect(chunk.context.test).toBe(`id-${count++}`);
      },
    });
    const writer = transport.writable.getWriter();
    writer.write(
      new AwarenessMessage(
        "test",
        new Uint8Array([
          0x00, 0x00, 0x01, 0x02, 0x03,
        ]) as AwarenessUpdateMessage,
        { test: "id-1" },
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    writer.write(
      new AwarenessMessage(
        "test",
        new Uint8Array([
          0x00, 0x00, 0x01, 0x02, 0x03,
        ]) as AwarenessUpdateMessage,
        { test: "id-2" },
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    writer.write(
      new AwarenessMessage(
        "test",
        new Uint8Array([
          0x00, 0x00, 0x01, 0x02, 0x03,
        ]) as AwarenessUpdateMessage,
        { test: "id-3" },
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    writer.close();
  });
});
