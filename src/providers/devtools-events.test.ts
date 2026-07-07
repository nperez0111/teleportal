import { describe, expect, it } from "bun:test";
import { DevtoolsEventClient } from "./devtools-events";

type TestEventMap = {
  "test:ping": { value: number };
  "test:other": { name: string };
};

describe("DevtoolsEventClient", () => {
  it("delivers payloads wrapped in a typed event envelope", () => {
    const client = new DevtoolsEventClient<TestEventMap>("test");
    const received: unknown[] = [];

    client.on("test:ping", (event) => {
      received.push(event);
    });
    client.emit("test:ping", { value: 42 });

    expect(received).toEqual([{ type: "test:ping", payload: { value: 42 }, pluginId: "test" }]);
  });

  it("delivers payloads by reference without serializing", () => {
    const client = new DevtoolsEventClient<TestEventMap>("test");
    const payload = { value: 1 };
    let receivedPayload: unknown;

    client.on("test:ping", (event) => {
      receivedPayload = event.payload;
    });
    client.emit("test:ping", payload);

    expect(receivedPayload).toBe(payload);
  });

  it("only notifies listeners of the emitted event", () => {
    const client = new DevtoolsEventClient<TestEventMap>("test");
    const pings: number[] = [];
    const others: string[] = [];

    client.on("test:ping", (event) => pings.push(event.payload.value));
    client.on("test:other", (event) => others.push(event.payload.name));
    client.emit("test:ping", { value: 7 });

    expect(pings).toEqual([7]);
    expect(others).toEqual([]);
  });

  it("stops delivering after unsubscribe", () => {
    const client = new DevtoolsEventClient<TestEventMap>("test");
    const received: number[] = [];

    const unsubscribe = client.on("test:ping", (event) => received.push(event.payload.value));
    client.emit("test:ping", { value: 1 });
    unsubscribe();
    client.emit("test:ping", { value: 2 });

    expect(received).toEqual([1]);
  });

  it("isolates listener errors from the emitter and other listeners", () => {
    const client = new DevtoolsEventClient<TestEventMap>("test");
    const received: number[] = [];

    client.on("test:ping", () => {
      throw new Error("observer bug");
    });
    client.on("test:ping", (event) => received.push(event.payload.value));

    expect(() => client.emit("test:ping", { value: 3 })).not.toThrow();
    expect(received).toEqual([3]);
  });

  it("is a no-op when emitting with no listeners", () => {
    const client = new DevtoolsEventClient<TestEventMap>("test");
    expect(() => client.emit("test:ping", { value: 1 })).not.toThrow();
  });
});
