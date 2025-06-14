import { describe, expect, it } from "bun:test";

import type { YAwarenessUpdate, YTransport } from "../base";
import {
  type AwarenessUpdateMessage,
  type SyncStep1,
  type SyncStep2,
  type UpdateStep,
  type Message,
  DocMessage,
  AwarenessMessage,
  StateVector,
  Update,
} from "../protocol";
import { noopTransport, withPassthrough } from "./passthrough";

export function generateTestTransport(
  type: "doc" | "awareness",
): YTransport<{ test: string }, {}> {
  if (type === "doc") {
    return {
      readable: new ReadableStream<Message<{ test: string }>>({
        async start(controller) {
          controller.enqueue(
            new DocMessage(
              "test",
              {
                type: "sync-step-1",
                sv: new Uint8Array([
                  0x00, 0x00, 0x01, 0x02, 0x03,
                ]) as StateVector,
              },
              { test: "id-1" },
            ),
          );

          await new Promise((resolve) => setTimeout(resolve, 0));

          controller.enqueue(
            new DocMessage(
              "test",
              {
                type: "sync-step-2",
                update: new Uint8Array([
                  0x01, 0x00, 0x01, 0x02, 0x03,
                ]) as Update,
              },
              { test: "id-2" },
            ),
          );

          await new Promise((resolve) => setTimeout(resolve, 0));

          controller.enqueue(
            new DocMessage(
              "test",
              {
                type: "update",
                update: new Uint8Array([
                  0x02, 0x00, 0x01, 0x02, 0x03,
                ]) as Update,
              },
              { test: "id-3" },
            ),
          );

          controller.close();
        },
      }),
      writable: new WritableStream<Message<{ test: string }>>(),
    };
  } else {
    return {
      writable: new WritableStream<Message<{ test: string }>>(),
      readable: new ReadableStream<YAwarenessUpdate<{ test: string }>>({
        async start(controller) {
          controller.enqueue(
            new AwarenessMessage(
              "test",
              {
                type: "awareness-update",
                update: new Uint8Array([
                  0x00, 0x01, 0x02, 0x03,
                ]) as AwarenessUpdateMessage,
              },
              { test: "id-1" },
            ),
          );

          await new Promise((resolve) => setTimeout(resolve, 0));

          controller.enqueue(
            new AwarenessMessage(
              "test",
              {
                type: "awareness-update",
                update: new Uint8Array([
                  0x00, 0x01, 0x02, 0x03,
                ]) as AwarenessUpdateMessage,
              },
              { test: "id-2" },
            ),
          );

          await new Promise((resolve) => setTimeout(resolve, 0));

          controller.enqueue(
            new AwarenessMessage(
              "test",
              {
                type: "awareness-update",
                update: new Uint8Array([
                  0x00, 0x01, 0x02, 0x03,
                ]) as AwarenessUpdateMessage,
              },
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
    const transport = withPassthrough(noopTransport(), {
      onWrite(chunk) {
        expect(chunk.context.test).toBe(`id-${count++}`);
      },
    });
    const writer = transport.writable.getWriter();
    writer.write(
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

    writer.write(
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

    writer.write(
      new DocMessage(
        "test",
        {
          type: "sync-step-2",
          update: new Uint8Array([0x00, 0x00, 0x01, 0x02, 0x03]) as Update,
        },
        { test: "id-3" },
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    writer.close();
  });
  it("can write awareness", async () => {
    let count = 1;
    const transport = withPassthrough(noopTransport(), {
      onWrite(chunk) {
        expect(chunk.context.test).toBe(`id-${count++}`);
      },
    });
    const writer = transport.writable.getWriter();
    writer.write(
      new AwarenessMessage(
        "test",
        {
          type: "awareness-update",
          update: new Uint8Array([
            0x00, 0x00, 0x01, 0x02, 0x03,
          ]) as AwarenessUpdateMessage,
        },
        { test: "id-1" },
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    writer.write(
      new AwarenessMessage(
        "test",
        {
          type: "awareness-update",
          update: new Uint8Array([
            0x00, 0x00, 0x01, 0x02, 0x03,
          ]) as AwarenessUpdateMessage,
        },
        { test: "id-2" },
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    writer.write(
      new AwarenessMessage(
        "test",
        {
          type: "awareness-update",
          update: new Uint8Array([
            0x00, 0x00, 0x01, 0x02, 0x03,
          ]) as AwarenessUpdateMessage,
        },
        { test: "id-3" },
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    writer.close();
  });
});
