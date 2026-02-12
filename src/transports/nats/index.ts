import type { NatsConnection } from "@nats-io/transport-node";
import {
  type BinaryMessage,
  decodePubSubMessage,
  encodePubSubMessage,
  type PubSub,
  type PubSubTopic,
} from "teleportal";
import { emitWideEvent } from "teleportal/server";

export class NatsPubSub implements PubSub {
  private nc: Promise<NatsConnection>;

  constructor(getConnection: () => Promise<NatsConnection>) {
    this.nc = getConnection();
  }

  async publish(
    topic: PubSubTopic,
    message: BinaryMessage,
    sourceId: string,
  ): Promise<void> {
    // Encode the message with instance ID to avoid loops
    const encoded = encodePubSubMessage(message, sourceId);
    (await this.nc).publish(topic, encoded);
  }
  async subscribe(
    topic: PubSubTopic,
    callback: (message: BinaryMessage, sourceId: string) => void,
  ): Promise<() => Promise<void>> {
    const subscription = (await this.nc).subscribe(topic, {
      callback: (err, msg) => {
        if (err) {
          throw err;
        }

        try {
          const decoded = decodePubSubMessage(msg.data);

          callback(decoded.message, decoded.sourceId);
        } catch (error) {
          emitWideEvent("error", {
            event_type: "nats_decode_error",
            timestamp: new Date().toISOString(),
            topic,
            error,
          });
        }
      },
    });

    return async () => {
      subscription.unsubscribe();
    };
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await (await this.nc).drain();
    // Free the memory
    (this.nc as any) = null;
  }
}
