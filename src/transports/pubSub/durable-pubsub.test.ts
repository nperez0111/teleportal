import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  BinaryMessage,
  DocMessage,
  InMemoryPubSub,
  isDurablePubSub,
  PubSubOffset,
  PubSubTopic,
  Update,
  type VersionedUpdate,
} from "teleportal";

function msg(n: number): BinaryMessage {
  return new DocMessage(
    "doc",
    {
      type: "update",
      update: { version: 2, data: new Uint8Array([n]) as Update } as VersionedUpdate,
    },
    { clientId: "c", userId: "u", room: "r" },
  ).encoded;
}

function presence(): BinaryMessage {
  return new DocMessage("doc", { type: "sync-done" }, { clientId: "c", userId: "u", room: "r" })
    .encoded;
}

type Received = { message: BinaryMessage; sourceId: string; offset: PubSubOffset | undefined };

describe("InMemoryPubSub durability", () => {
  let pubSub: InMemoryPubSub;
  const topic: PubSubTopic = "document/doc";

  beforeEach(() => {
    pubSub = new InMemoryPubSub();
  });

  afterEach(async () => {
    await pubSub[Symbol.asyncDispose]();
  });

  it("advertises durability and narrows via isDurablePubSub", () => {
    expect(pubSub.durable).toBe(true);
    expect(isDurablePubSub(pubSub)).toBe(true);
  });

  it("delivers live messages (parity with plain subscribe)", async () => {
    const got: BinaryMessage[] = [];
    const unsub = await pubSub.subscribe(topic, (m) => got.push(m));
    await pubSub.publish(topic, msg(1), "n1");
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual(msg(1));
    await unsub();
  });

  it("replays after an offset then continues live, in order with defined offsets", async () => {
    // First live consumer captures the offset of msg 1.
    const live: Received[] = [];
    const unsubLive = await pubSub.subscribeDurable(topic, (message, sourceId, offset) =>
      live.push({ message, sourceId, offset }),
    );
    await pubSub.publish(topic, msg(1), "n1");
    await pubSub.publish(topic, msg(2), "n1");
    const afterFirst = live[0].offset!;
    expect(afterFirst).toBeDefined();

    // Second consumer resumes after msg 1: should replay msg 2, then get msg 3 live.
    const replayed: Received[] = [];
    const unsubReplay = await pubSub.subscribeDurable(
      topic,
      (message, sourceId, offset) => replayed.push({ message, sourceId, offset }),
      { start: { after: afterFirst } },
    );
    expect(replayed.map((r) => r.message)).toEqual([msg(2)]);

    await pubSub.publish(topic, msg(3), "n1");
    expect(replayed.map((r) => r.message)).toEqual([msg(2), msg(3)]);
    // Offsets are strictly increasing and defined for durable messages.
    expect(replayed.every((r) => r.offset !== undefined)).toBe(true);
    expect(replayed[1].offset! > replayed[0].offset!).toBe(true);

    await unsubLive();
    await unsubReplay();
  });

  it("start:'new' skips the backlog", async () => {
    await pubSub.publish(topic, msg(1), "n1");
    const got: BinaryMessage[] = [];
    const unsub = await pubSub.subscribeDurable(topic, (m) => got.push(m), { start: "new" });
    expect(got).toHaveLength(0);
    await pubSub.publish(topic, msg(2), "n1");
    expect(got).toEqual([msg(2)]);
    await unsub();
  });

  it("trims to maxLen and fires onGap when resuming from a trimmed offset", async () => {
    const small = new InMemoryPubSub({ maxLen: 2 });
    try {
      // Capture the offset of msg 1 before it is trimmed out.
      let firstOffset: PubSubOffset | undefined;
      const unsubProbe = await small.subscribeDurable(topic, (_m, _s, offset) => {
        firstOffset ??= offset;
      });
      await small.publish(topic, msg(1), "n1");
      await small.publish(topic, msg(2), "n1"); // wanted-after-msg1, but will be evicted
      await small.publish(topic, msg(3), "n1");
      await small.publish(topic, msg(4), "n1"); // buffer now holds [msg3, msg4]; msg1, msg2 evicted
      await unsubProbe();

      const gaps: PubSubTopic[] = [];
      const replayed: BinaryMessage[] = [];
      const unsub = await small.subscribeDurable(topic, (m) => replayed.push(m), {
        start: { after: firstOffset! },
        onGap: (t) => gaps.push(t),
      });

      // Resuming after msg 1 wants msg 2..4, but msg 2 was trimmed → onGap, then replay
      // whatever is still retained (msg 3, msg 4).
      expect(gaps).toEqual([topic]);
      expect(replayed).toEqual([msg(3), msg(4)]);
      await unsub();
    } finally {
      await small[Symbol.asyncDispose]();
    }
  });

  it("delivers ephemeral messages live with undefined offset and never replays them", async () => {
    const live: Received[] = [];
    const unsubLive = await pubSub.subscribeDurable(topic, (message, sourceId, offset) =>
      live.push({ message, sourceId, offset }),
    );
    await pubSub.publish(topic, presence(), "n1", { ephemeral: true });
    expect(live).toHaveLength(1);
    expect(live[0].offset).toBeUndefined();

    // A fresh replay-everything consumer must not see the ephemeral message.
    const replayed: BinaryMessage[] = [];
    const unsubReplay = await pubSub.subscribeDurable(topic, (m) => replayed.push(m), {
      start: { after: "0" },
    });
    expect(replayed).toHaveLength(0);

    await unsubLive();
    await unsubReplay();
  });

  it("stops delivery after unsubscribe", async () => {
    let count = 0;
    const unsub = await pubSub.subscribeDurable(topic, () => count++);
    await pubSub.publish(topic, msg(1), "n1");
    expect(count).toBe(1);
    await unsub();
    await pubSub.publish(topic, msg(2), "n1");
    expect(count).toBe(1);
  });
});
