import type { NatsConnection } from "@nats-io/transport-node";
import { NatsPubSub } from "teleportal/transports/nats";
import { PubSubReplicator } from "./replicator";

export function createNatsReplicator(getConnection: () => Promise<NatsConnection>, nodeId: string) {
  return new PubSubReplicator({ pubsub: new NatsPubSub(getConnection), nodeId });
}
