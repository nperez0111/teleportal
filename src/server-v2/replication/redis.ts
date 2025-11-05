import { RedisPubSub } from "teleportal/transports/redis";
import { PubSubReplicator } from "./replicator";

export function createRedisReplicator(options: { path: string; options?: import("ioredis").RedisOptions }, nodeId: string) {
  return new PubSubReplicator({ pubsub: new RedisPubSub(options), nodeId });
}
