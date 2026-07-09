import { beforeAll, describe, expect, test } from "bun:test";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import type { BinaryMessage, PubSubOffset, PubSubTopic } from "teleportal";
import { NatsJetStreamPubSub } from "./jetstream";

const JS_URL = process.env.NATS_JS_URL || "nats://localhost:4222";
const CORE_URL = process.env.NATS_CORE_URL || "nats://localhost:4223";
const TEST_TIMEOUT = 8000;

async function jetStreamAvailable(url: string): Promise<boolean> {
  try {
    const nc = await connect({ servers: url, maxReconnectAttempts: 1, timeout: 1000 });
    const jsm = await jetstreamManager(nc);
    await jsm.getAccountInfo();
    await nc.close();
    return true;
  } catch {
    return false;
  }
}

async function serverReachable(url: string): Promise<boolean> {
  try {
    const nc = await connect({ servers: url, maxReconnectAttempts: 1, timeout: 1000 });
    await nc.close();
    return true;
  } catch {
    return false;
  }
}

async function pollUntil(
  fn: () => boolean | Promise<boolean>,
  timeoutMs = 4000,
  intervalMs = 10,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("pollUntil timed out");
}

function bytes(n: number): BinaryMessage {
  return new Uint8Array([n]) as unknown as BinaryMessage;
}

describe("NatsJetStreamPubSub", () => {
  let jsAvailable: boolean;
  let coreAvailable: boolean;
  let counter = 0;

  beforeAll(async () => {
    jsAvailable = await jetStreamAvailable(JS_URL);
    coreAvailable = await serverReachable(CORE_URL);
  });

  // Unique stream + subject namespace per instance so tests don't cross-talk.
  function make(url = JS_URL, overrides?: Record<string, unknown>) {
    const uid = `t${Date.now()}_${counter++}`;
    const getConnection = () => connect({ servers: url, maxReconnectAttempts: 5, timeout: 1000 });
    return new NatsJetStreamPubSub(getConnection, {
      streamName: `teleportal_${uid}`,
      subjectPrefix: `tp_${uid}`,
      ...overrides,
    });
  }

  test(
    "advertises durability",
    async () => {
      if (!jsAvailable) return;
      const ps = make();
      expect(ps.durable).toBe(true);
      await ps[Symbol.asyncDispose]();
    },
    TEST_TIMEOUT,
  );

  test(
    "fails fast when JetStream is not enabled",
    async () => {
      if (!coreAvailable) return;
      const ps = make(CORE_URL);
      await expect(ps.ready()).rejects.toThrow();
      await ps[Symbol.asyncDispose]().catch(() => {});
    },
    TEST_TIMEOUT,
  );

  test(
    "delivers live durable messages",
    async () => {
      if (!jsAvailable) return;
      const ps = make();
      const topic: PubSubTopic = "document/live";
      try {
        const got: number[] = [];
        await ps.subscribe(topic, (m) => got.push((m as Uint8Array)[0]));
        // Ordered consumer needs to be established before publishing.
        await new Promise((r) => setTimeout(r, 100));
        await ps.publish(topic, bytes(1), "n1");
        await pollUntil(() => got.includes(1));
        expect(got).toEqual([1]);
      } finally {
        await ps[Symbol.asyncDispose]();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "demultiplexes two topics from one consumer",
    async () => {
      if (!jsAvailable) return;
      const ps = make();
      try {
        const a: number[] = [];
        const b: number[] = [];
        await ps.subscribe("document/a" as PubSubTopic, (m) => a.push((m as Uint8Array)[0]));
        await ps.subscribe("document/b" as PubSubTopic, (m) => b.push((m as Uint8Array)[0]));
        await new Promise((r) => setTimeout(r, 100));
        await ps.publish("document/a" as PubSubTopic, bytes(10), "n1");
        await ps.publish("document/b" as PubSubTopic, bytes(20), "n1");
        await pollUntil(() => a.includes(10) && b.includes(20));
        expect(a).toEqual([10]);
        expect(b).toEqual([20]);
      } finally {
        await ps[Symbol.asyncDispose]();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "replays from an offset (cold catch-up)",
    async () => {
      if (!jsAvailable) return;
      const ps = make();
      const topic: PubSubTopic = "document/replay";
      try {
        // Capture the offset of message A live.
        const liveOffsets: (PubSubOffset | undefined)[] = [];
        const unsub = await ps.subscribeDurable(topic, (_m, _s, o) => liveOffsets.push(o));
        await new Promise((r) => setTimeout(r, 100));
        await ps.publish(topic, bytes(1), "n1");
        await pollUntil(() => liveOffsets.length >= 1);
        const afterA = liveOffsets[0]!;
        await unsub();

        await ps.publish(topic, bytes(2), "n1");
        await ps.publish(topic, bytes(3), "n1");

        const got: number[] = [];
        await ps.subscribeDurable(topic, (m) => got.push((m as Uint8Array)[0]), {
          start: { after: afterA },
        });
        await pollUntil(() => got.length >= 2);
        expect(got).toEqual([2, 3]);
      } finally {
        await ps[Symbol.asyncDispose]();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "ephemeral publishes never hit the stream",
    async () => {
      if (!jsAvailable) return;
      const ps = make();
      const topic: PubSubTopic = "document/ephemeral";
      const nc: NatsConnection = await connect({ servers: JS_URL });
      try {
        await ps.ready();
        await ps.publish(topic, bytes(1), "n1", { ephemeral: true });
        await new Promise((r) => setTimeout(r, 100));
        const jsm = await jetstreamManager(nc);
        const info = await jsm.streams.info((ps as any).streamName ?? "");
        expect(info.state.messages).toBe(0);
      } finally {
        await nc.close();
        await ps[Symbol.asyncDispose]();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "fires onGap when the resume point was purged for this subject (per-subject retention)",
    async () => {
      if (!jsAvailable) return;
      const ps = make(JS_URL, { maxMsgsPerSubject: 2 });
      const topic: PubSubTopic = "document/purge";
      const other: PubSubTopic = "document/other";
      const nc: NatsConnection = await connect({ servers: JS_URL });
      try {
        // Capture the offset of the first message on `topic`.
        const liveOffsets: (PubSubOffset | undefined)[] = [];
        const unsub = await ps.subscribeDurable(topic, (_m, _s, o) => liveOffsets.push(o));
        await new Promise((r) => setTimeout(r, 100));
        await ps.publish(topic, bytes(1), "n1");
        await pollUntil(() => liveOffsets.length >= 1);
        const afterFirst = liveOffsets[0]!;
        await unsub();

        // Keep a low-traffic OTHER subject alive with an old message, so the stream's global
        // first_seq stays low even after `topic`'s messages are purged. A naive global-first_seq
        // check would miss the gap; the per-subject check must catch it.
        await ps.publish(other, bytes(99), "n1");

        // Flood `topic` past its per-subject retention (2) so message #1 is purged.
        for (let i = 2; i <= 8; i++) await ps.publish(topic, bytes(i), "n1");
        const jsm = await jetstreamManager(nc);
        await pollUntil(async () => {
          const info = await jsm.streams.info((ps as any).streamName);
          return info.state.messages <= 3; // ~2 for topic + 1 for other
        });

        // Resuming from the (now purged) first offset must fire onGap.
        const gaps: PubSubTopic[] = [];
        const unsub2 = await ps.subscribeDurable(topic, () => {}, {
          start: { after: afterFirst },
          onGap: (t) => gaps.push(t),
        });
        expect(gaps).toContain(topic);
        await unsub2();
      } finally {
        await nc.close();
        await ps[Symbol.asyncDispose]();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "retains at most max_msgs_per_subject per subject",
    async () => {
      if (!jsAvailable) return;
      const ps = make(JS_URL, { maxMsgsPerSubject: 5 });
      const topic: PubSubTopic = "document/retain";
      const nc: NatsConnection = await connect({ servers: JS_URL });
      try {
        await ps.ready();
        for (let i = 0; i < 30; i++) {
          await ps.publish(topic, bytes(i & 0xff), "n1");
        }
        await new Promise((r) => setTimeout(r, 100));
        const jsm = await jetstreamManager(nc);
        const info = await jsm.streams.info((ps as any).streamName ?? "");
        expect(info.state.messages).toBeLessThanOrEqual(5);
      } finally {
        await nc.close();
        await ps[Symbol.asyncDispose]();
      }
    },
    TEST_TIMEOUT,
  );
});
