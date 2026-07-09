import type { NatsConnection } from "@nats-io/transport-node";
import {
  type ConsumerMessages,
  DeliverPolicy,
  type JetStreamClient,
  type JetStreamManager,
  type JsMsg,
  jetstream,
  jetstreamManager,
  RetentionPolicy,
  StorageType,
} from "@nats-io/jetstream";
import {
  type BinaryMessage,
  decodePubSubMessage,
  type DurablePubSub,
  type DurableSubscribeOptions,
  encodePubSubMessage,
  type PublishOptions,
  type PubSubOffset,
  type PubSubTopic,
  type SubscribeOptions,
} from "teleportal";
import { emitWideEvent } from "teleportal/server";
import { NatsPubSub } from "./index";

/**
 * Configuration for {@link NatsJetStreamPubSub}.
 */
export interface NatsJetStreamOptions {
  /** JetStream stream name. Default `"teleportal"`. */
  streamName?: string;
  /** Subject namespace for durable traffic (`<prefix>.<topic>`). Default `"teleportal"`. */
  subjectPrefix?: string;
  /** Per-subject retention cap (the per-topic analog of Redis MAXLEN). Default 10_000. */
  maxMsgsPerSubject?: number;
  /** Max age retention (ms). Default off. */
  maxAgeMs?: number;
  /** Idempotently create/update the stream on first use. Default true. */
  manageStream?: boolean;
  /**
   * Whether a topic uses the durable stream. Default: `document/*` is durable, everything else
   * stays on core NATS. Returning `false` for all topics makes this behave like core NATS.
   */
  isDurableTopic?: (topic: PubSubTopic) => boolean;
}

type DurableCallback = (
  message: BinaryMessage,
  sourceId: string,
  offset: PubSubOffset | undefined,
) => void;

/**
 * NATS JetStream implementation of {@link DurablePubSub}.
 *
 * Ships as a separate opt-in export (`teleportal/transports/nats/jetstream`) so core-NATS users
 * of {@link NatsPubSub} never pull in `@nats-io/jetstream`. Durable traffic is persisted to a
 * single JetStream stream bound to `<prefix>.>` and consumed by ONE multiplexed ordered
 * consumer (demultiplexed by subject) — mirroring the Redis single-`XREAD` design and avoiding a
 * consumer per document. Ordered consumers auto-recreate on reconnect, so catch-up is
 * transparent. Ephemeral publishes and non-durable topics use core NATS via a composed
 * {@link NatsPubSub} over the same connection.
 *
 * Do NOT mix this with plain {@link NatsPubSub} nodes in the same deployment: durable traffic is
 * published to the prefixed subject `<prefix>.<topic>`, which a core-NATS node subscribed to the
 * bare `<topic>` never sees — updates would silently not propagate to it. Run one backend
 * cluster-wide.
 */
export class NatsJetStreamPubSub implements DurablePubSub {
  public readonly durable = true as const;
  public readonly streamName: string;

  #subjectPrefix: string;
  #maxMsgsPerSubject: number;
  #maxAgeMs: number | undefined;
  #manageStream: boolean;
  #isDurableTopic: (topic: PubSubTopic) => boolean;

  #connPromise: Promise<NatsConnection>;
  #plain: NatsPubSub;
  #ready: Promise<void>;
  #js!: JetStreamClient;
  #jsm!: JetStreamManager;

  #live = new Map<
    PubSubTopic,
    { callbacks: Set<DurableCallback>; onGaps: Set<(topic: PubSubTopic) => void> }
  >();
  #liveMessages: ConsumerMessages | undefined;
  #liveStarting: Promise<void> | undefined;
  #replayConsumers = new Set<ConsumerMessages>();
  /**
   * Expected next stream sequence on the live consumer. Because the consumer filters the whole
   * stream (`<prefix>.>`), delivered sequences are contiguous — a jump means messages were purged
   * (or trimming overtook a lagging reader) i.e. a gap. Only trusted when {@link #liveContiguous}.
   */
  #liveExpectedSeq: number | undefined;
  /** Whether the stream contains exactly `<prefix>.>` (so live-consumer sequences are contiguous). */
  #liveContiguous = true;

  constructor(getConnection: () => Promise<NatsConnection>, options?: NatsJetStreamOptions) {
    this.streamName = options?.streamName ?? "teleportal";
    this.#subjectPrefix = options?.subjectPrefix ?? "teleportal";
    this.#maxMsgsPerSubject = options?.maxMsgsPerSubject ?? 10_000;
    this.#maxAgeMs = options?.maxAgeMs;
    this.#manageStream = options?.manageStream ?? true;
    this.#isDurableTopic = options?.isDurableTopic ?? ((topic) => topic.startsWith("document/"));

    // Share one connection between the durable (JetStream) and ephemeral (core NATS) halves.
    this.#connPromise = getConnection();
    this.#plain = new NatsPubSub(() => this.#connPromise);
    this.#ready = this.#init();
    // Mark the promise handled so a rejection (e.g. no JetStream) doesn't surface as an
    // unhandled rejection when nobody awaits ready()/publish() before disposing.
    this.#ready.catch(() => {});
  }

  /** Resolves once JetStream is confirmed available and the stream is provisioned; rejects with
   *  a clear error (pointing at {@link NatsPubSub}) if the server has no JetStream. */
  ready(): Promise<void> {
    return this.#ready;
  }

  async #init(): Promise<void> {
    const nc = await this.#connPromise;
    try {
      this.#jsm = await jetstreamManager(nc);
      // Probe: fails fast on a core-only NATS server — no silent downgrade.
      await this.#jsm.getAccountInfo();
    } catch (error) {
      throw new Error(
        `JetStream is not available on this NATS server. Use NatsPubSub (teleportal/transports/nats) ` +
          `for core NATS, or start the server with '-js'. Cause: ${
            error instanceof Error ? error.message : String(error)
          }`,
      );
    }
    this.#js = jetstream(nc);
    if (this.#manageStream) {
      await this.#provisionStream();
    }

    // Live-consumer gap detection relies on the consumer seeing EVERY message in the stream (so
    // its delivered sequences are contiguous). That holds iff the stream's subjects are exactly
    // `<prefix>.>`. With a pre-provisioned stream that carries extra subjects, disable it to
    // avoid a resync storm from benign sequence jumps (replay-path gap detection still works).
    try {
      const info = await this.#jsm.streams.info(this.streamName);
      const subjects = info.config.subjects ?? [];
      this.#liveContiguous = subjects.length === 1 && subjects[0] === `${this.#subjectPrefix}.>`;
    } catch {
      this.#liveContiguous = this.#manageStream;
    }
  }

  async #provisionStream(): Promise<void> {
    const cfg = {
      name: this.streamName,
      subjects: [`${this.#subjectPrefix}.>`],
      max_msgs_per_subject: this.#maxMsgsPerSubject,
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      ...(this.#maxAgeMs ? { max_age: this.#maxAgeMs * 1_000_000 } : {}),
    };
    try {
      await this.#jsm.streams.add(cfg);
    } catch {
      // Stream already exists (or its config drifted) → converge it.
      await this.#jsm.streams.update(this.streamName, cfg);
    }
  }

  #subject(topic: PubSubTopic): string {
    return `${this.#subjectPrefix}.${topic}`;
  }

  async publish(
    topic: PubSubTopic,
    message: BinaryMessage,
    sourceId: string,
    options?: PublishOptions,
  ): Promise<void> {
    await this.#ready;
    if (this.#isDurableTopic(topic) && !options?.ephemeral) {
      const encoded = encodePubSubMessage(message, sourceId);
      await this.#js.publish(this.#subject(topic), encoded);
    } else {
      await this.#plain.publish(topic, message, sourceId);
    }
  }

  async subscribe(
    topic: PubSubTopic,
    callback: (message: BinaryMessage, sourceId: string) => void,
    options?: SubscribeOptions,
  ): Promise<() => Promise<void>> {
    return this.subscribeDurable(topic, (message, sourceId) => callback(message, sourceId), {
      start: "new",
      onGap: options?.onGap,
    });
  }

  async subscribeDurable(
    topic: PubSubTopic,
    callback: DurableCallback,
    options?: DurableSubscribeOptions,
  ): Promise<() => Promise<void>> {
    await this.#ready;
    if (!this.#isDurableTopic(topic)) {
      return this.#plain.subscribe(topic, (m, s) => callback(m, s, undefined));
    }

    const start = options?.start ?? "new";
    const unsubStream =
      typeof start === "object"
        ? await this.#subscribeReplay(topic, callback, start.after, options?.onGap)
        : await this.#subscribeLive(topic, callback, options?.onGap);

    // Fan in the ephemeral core-NATS channel (offset undefined) for this topic.
    const unsubPlain = await this.#plain.subscribe(topic, (m, s) => callback(m, s, undefined));

    return async () => {
      await unsubStream();
      await unsubPlain();
    };
  }

  async #subscribeLive(
    topic: PubSubTopic,
    callback: DurableCallback,
    onGap?: (topic: PubSubTopic) => void,
  ): Promise<() => Promise<void>> {
    let entry = this.#live.get(topic);
    if (!entry) {
      entry = { callbacks: new Set(), onGaps: new Set() };
      this.#live.set(topic, entry);
    }
    entry.callbacks.add(callback);
    if (onGap) entry.onGaps.add(onGap);
    await this.#ensureLiveConsumer();

    return async () => {
      const e = this.#live.get(topic);
      if (e) {
        e.callbacks.delete(callback);
        if (onGap) e.onGaps.delete(onGap);
        if (e.callbacks.size === 0) {
          this.#live.delete(topic);
        }
      }
    };
  }

  async #ensureLiveConsumer(): Promise<void> {
    if (this.#liveMessages) return;
    if (this.#liveStarting) return this.#liveStarting;
    this.#liveStarting = (async () => {
      const consumer = await this.#js.consumers.get(this.streamName, {
        filter_subjects: [`${this.#subjectPrefix}.>`],
        deliver_policy: DeliverPolicy.New,
      });
      this.#liveMessages = await consumer.consume({
        callback: (msg) => this.#dispatchLive(msg),
      });
    })();
    return this.#liveStarting;
  }

  #dispatchLive(msg: JsMsg): void {
    // Contiguity gap detection: a jump in the stream sequence means messages were purged (or
    // trimming overtook this reader) i.e. an unrecoverable gap. We can't know which subjects were
    // affected (they're gone), so conservatively fire onGap for every live topic — each session
    // then re-syncs from storage. A spurious heal costs one storage read; a missed one leaves a
    // node silently stale.
    if (
      this.#liveContiguous &&
      this.#liveExpectedSeq !== undefined &&
      msg.seq > this.#liveExpectedSeq
    ) {
      for (const [t, entry] of this.#live) {
        for (const onGap of Array.from(entry.onGaps)) {
          onGap(t);
        }
      }
    }
    this.#liveExpectedSeq = msg.seq + 1;

    const prefix = `${this.#subjectPrefix}.`;
    if (!msg.subject.startsWith(prefix)) return;
    const topic = msg.subject.slice(prefix.length) as PubSubTopic;
    const entry = this.#live.get(topic);
    if (!entry) return;
    let decoded;
    try {
      decoded = decodePubSubMessage(msg.data);
    } catch (error) {
      emitWideEvent("error", {
        event_type: "nats_stream_decode_error",
        timestamp: new Date().toISOString(),
        topic,
        error,
      });
      return;
    }
    const offset = String(msg.seq);
    for (const cb of Array.from(entry.callbacks)) {
      cb(decoded.message, decoded.sourceId, offset);
    }
  }

  /** Stream sequence of the oldest retained message on a subject, or undefined if none. */
  async #oldestSeqForSubject(subject: string): Promise<number | undefined> {
    try {
      // "first message on `subject` at or after seq 1" = the oldest retained on that subject. The
      // server supports `next_by_subj`; the `MsgRequest` type omits it, hence the cast.
      const msg = await this.#jsm.streams.getMessage(this.streamName, {
        seq: 1,
        next_by_subj: subject,
      } as unknown as Parameters<JetStreamManager["streams"]["getMessage"]>[1]);
      return msg?.seq;
    } catch {
      // No message at/after seq 1 on this subject (empty) → treat as no retained history.
      return undefined;
    }
  }

  async #subscribeReplay(
    topic: PubSubTopic,
    callback: DurableCallback,
    after: PubSubOffset,
    onGap?: (topic: PubSubTopic) => void,
  ): Promise<() => Promise<void>> {
    const afterSeq = Number(after);
    // Gap detection must be PER SUBJECT: retention is `max_msgs_per_subject`, so this document's
    // messages can be purged while the stream's global `first_seq` still points at some other
    // low-traffic document's older message. Ask for the oldest retained message on THIS subject;
    // if it is newer than the resume point, messages we wanted were purged → signal a gap.
    const oldest = await this.#oldestSeqForSubject(this.#subject(topic));
    if (oldest !== undefined && oldest > afterSeq) {
      onGap?.(topic);
    }

    const consumer = await this.#js.consumers.get(this.streamName, {
      filter_subjects: [this.#subject(topic)],
      deliver_policy: DeliverPolicy.StartSequence,
      opt_start_seq: afterSeq + 1,
    });
    const messages = await consumer.consume({
      callback: (msg) => {
        let decoded;
        try {
          decoded = decodePubSubMessage(msg.data);
        } catch {
          return;
        }
        callback(decoded.message, decoded.sourceId, String(msg.seq));
      },
    });
    this.#replayConsumers.add(messages);

    return async () => {
      await messages.close().catch(() => {});
      this.#replayConsumers.delete(messages);
    };
  }

  async [Symbol.asyncDispose](): Promise<void> {
    // Let any in-flight init settle so we don't drain the connection mid-provision.
    await this.#ready.catch(() => {});
    await this.#liveMessages?.close().catch(() => {});
    for (const m of this.#replayConsumers) {
      await m.close().catch(() => {});
    }
    this.#replayConsumers.clear();
    await this.#plain[Symbol.asyncDispose]().catch(() => {});
  }
}
