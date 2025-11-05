import { InMemoryPubSub } from "teleportal";
import { PubSubReplicator } from "./replicator";
import { uuidv4 } from "lib0/random";

export function createInMemoryReplicator() {
  return new PubSubReplicator({ pubsub: new InMemoryPubSub(), nodeId: `node-${uuidv4()}` });
}
