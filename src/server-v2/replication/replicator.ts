import { decodeMessage, type Message } from "teleportal";
import { InMemoryPubSub, type PubSub } from "teleportal";

/**
 * Base Replicator contract and utilities.
 */
export interface Replicator {
  subscribe(
    documentId: string,
    onMessage: (message: Message<any>) => Promise<void> | void,
  ): Promise<() => Promise<void>>;
  publish(documentId: string, message: Message<any>): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export class PubSubReplicator implements Replicator {
  readonly #pubsub: PubSub;
  readonly #nodeId: string;

  constructor({ pubsub = new InMemoryPubSub(), nodeId }: { pubsub?: PubSub; nodeId: string }) {
    this.#pubsub = pubsub;
    this.#nodeId = nodeId;
  }

  async subscribe(
    documentId: string,
    onMessage: (message: Message<any>) => Promise<void> | void,
  ): Promise<() => Promise<void>> {
    const topic = `document/${documentId}` as const;
    const unsubscribe = await this.#pubsub.subscribe(
      topic,
      (binary, sourceId) => {
        if (sourceId === this.#nodeId) return;
        const msg = decodeMessage(binary);
        // Best-effort: ensure it matches the documentId
        if (msg.document !== documentId) return;
        void onMessage(msg);
      },
    );
    return unsubscribe;
  }

  async publish(documentId: string, message: Message<any>): Promise<void> {
    const topic = `document/${documentId}` as const;
    await this.#pubsub.publish(topic, message.encoded, this.#nodeId);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.#pubsub.destroy?.();
  }
}
