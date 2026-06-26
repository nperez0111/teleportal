import * as Y from "yjs";
import { Server } from "../src/server/server";
import { Connection } from "../src/providers/connection";
import { Provider } from "../src/providers/provider";
import { MemoryDocumentStorage } from "../src/storage/in-memory/document-storage";
import { createMemoryTransportPair } from "../src/providers/transports/memory";
import { InMemoryPubSub, type Message, type ServerContext, type Transport } from "teleportal";
import { createChannel } from "../src/lib/iter";

class BenchTransport<Context extends ServerContext> implements Transport<Context> {
  public source: AsyncIterable<Message<Context>[]>;
  #channel = createChannel<Message<Context>>();

  constructor() {
    this.source = this.#channel;
  }

  write(_message: Message<Context>): void {}
  close(): void {}
  async destroy() {}

  enqueueMessage(message: Message<Context>) {
    try {
      this.#channel.send(message);
    } catch {}
  }

  closeReadable() {
    this.#channel.close();
  }

  [key: string]: unknown;
}

export function createBenchServer(storage?: MemoryDocumentStorage) {
  const pubSub = new InMemoryPubSub();
  const docStorage = storage ?? new MemoryDocumentStorage(false);
  const server = new Server<ServerContext>({
    storage: docStorage,
    pubSub,
  });
  return { server, storage: docStorage, pubSub };
}

export async function createBenchServerWithClient(storage?: MemoryDocumentStorage) {
  const { server, storage: docStorage, pubSub } = createBenchServer(storage);
  const transport = new BenchTransport<ServerContext>();
  const client = server.createClient({ transport });
  return { server, storage: docStorage, pubSub, transport, client };
}

export async function createConnectedProviderPair(opts?: { document?: string }) {
  const document = opts?.document ?? "bench-doc";
  const storage = new MemoryDocumentStorage(false);
  const { server, pubSub } = createBenchServer(storage);

  const transport1 = new BenchTransport<ServerContext>();
  server.createClient({ transport: transport1 });

  const transport2 = new BenchTransport<ServerContext>();
  server.createClient({ transport: transport2 });

  const [clientTransport1, _serverTransport1] = createMemoryTransportPair();
  const conn1 = new Connection({
    transports: [clientTransport1],
    connect: false,
    batchIntervalMs: 0,
  });

  const [clientTransport2, _serverTransport2] = createMemoryTransportPair();
  const conn2 = new Connection({
    transports: [clientTransport2],
    connect: false,
    batchIntervalMs: 0,
  });

  await Promise.all([conn1.connect(), conn2.connect()]);

  const provider1 = new Provider({
    connection: conn1,
    document,
    encryptionKey: false,
    enableOfflinePersistence: false,
  });

  const provider2 = new Provider({
    connection: conn2,
    document,
    encryptionKey: false,
    enableOfflinePersistence: false,
  });

  return {
    provider1,
    provider2,
    conn1,
    conn2,
    server,
    storage,
    pubSub,
    async cleanup() {
      provider1.destroy();
      provider2.destroy();
      await server[Symbol.asyncDispose]();
      await pubSub[Symbol.asyncDispose]();
    },
  };
}

export function flush(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

export function createTestUpdate(content = "test"): Uint8Array {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, content);
  return Y.encodeStateAsUpdateV2(doc);
}

export function createLargeDoc(charCount: number): Y.Doc {
  const doc = new Y.Doc();
  const text = doc.getText("content");
  const chunk = "x".repeat(Math.min(charCount, 1000));
  for (let i = 0; i < charCount; i += chunk.length) {
    text.insert(i, chunk.substring(0, Math.min(chunk.length, charCount - i)));
  }
  return doc;
}

export function formatOps(ops: number, durationMs: number): string {
  const opsPerSec = (ops / durationMs) * 1000;
  if (opsPerSec >= 1_000_000) return `${(opsPerSec / 1_000_000).toFixed(1)}M ops/s`;
  if (opsPerSec >= 1_000) return `${(opsPerSec / 1_000).toFixed(1)}K ops/s`;
  return `${opsPerSec.toFixed(0)} ops/s`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms >= 1) return `${ms.toFixed(2)}ms`;
  return `${(ms * 1000).toFixed(0)}μs`;
}

type BenchResult = {
  name: string;
  iterations: number;
  totalMs: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  opsPerSec: number;
};

export async function bench(
  name: string,
  fn: () => unknown,
  opts?: { iterations?: number; warmup?: number },
): Promise<BenchResult> {
  const iterations = opts?.iterations ?? 100;
  const warmup = opts?.warmup ?? Math.min(10, Math.floor(iterations / 10));

  for (let i = 0; i < warmup; i++) {
    await fn();
  }

  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    times.push(performance.now() - start);
  }

  times.sort((a, b) => a - b);
  const totalMs = times.reduce((s, t) => s + t, 0);

  const result: BenchResult = {
    name,
    iterations,
    totalMs,
    avgMs: totalMs / iterations,
    minMs: times[0],
    maxMs: times[times.length - 1],
    p50Ms: times[Math.floor(iterations * 0.5)],
    p95Ms: times[Math.floor(iterations * 0.95)],
    p99Ms: times[Math.floor(iterations * 0.99)],
    opsPerSec: (iterations / totalMs) * 1000,
  };

  console.log(
    `  ${name}: avg=${formatDuration(result.avgMs)} p50=${formatDuration(result.p50Ms)} p95=${formatDuration(result.p95Ms)} p99=${formatDuration(result.p99Ms)} (${formatOps(iterations, totalMs)})`,
  );

  return result;
}

export async function benchBatch(
  name: string,
  fn: () => unknown,
  opts: { batchSize: number; iterations?: number; warmup?: number },
): Promise<BenchResult> {
  const iterations = opts.iterations ?? 10;
  const warmup = opts.warmup ?? 2;

  for (let i = 0; i < warmup; i++) {
    await fn();
  }

  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    times.push(performance.now() - start);
  }

  times.sort((a, b) => a - b);
  const totalMs = times.reduce((s, t) => s + t, 0);
  const totalOps = iterations * opts.batchSize;

  const result: BenchResult = {
    name,
    iterations,
    totalMs,
    avgMs: totalMs / iterations,
    minMs: times[0],
    maxMs: times[times.length - 1],
    p50Ms: times[Math.floor(iterations * 0.5)],
    p95Ms: times[Math.floor(iterations * 0.95)],
    p99Ms: times[Math.floor(iterations * 0.99)],
    opsPerSec: (totalOps / totalMs) * 1000,
  };

  console.log(
    `  ${name}: avg=${formatDuration(result.avgMs)} p50=${formatDuration(result.p50Ms)} p95=${formatDuration(result.p95Ms)} (${formatOps(totalOps, totalMs)}, ${opts.batchSize} ops/iter)`,
  );

  return result;
}
