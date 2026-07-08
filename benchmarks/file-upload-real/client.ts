/**
 * Real Bun WebSocket client for file upload benchmarks.
 * Connects to the benchmark server and uploads files through the full
 * Provider → Connection → WebSocket → Server pipeline.
 */
import { Provider, DirectConnection as Connection, websocketTransport } from "../../src/providers";
import { createFileRpc } from "../../src/protocols/file";
import { generateEncryptionKey } from "../../src/encryption-key";

const port = Number(process.env.BENCH_PORT) || 9877;
const sizeMB = Number(process.env.BENCH_SIZE_MB) || 100;
const encrypted = process.env.BENCH_ENCRYPTED !== "false";
const serverUrl = `http://localhost:${port}`;

async function fetchToken(): Promise<string> {
  const res = await fetch(`${serverUrl}/api/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: "bench-user", room: "bench" }),
  });
  const { token } = await res.json();
  return token;
}

function makeFile(size: number): File {
  const data = new Uint8Array(size);
  crypto.getRandomValues(data);
  return new File([data], "bench-file.bin", { type: "application/octet-stream" });
}

function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${ms.toFixed(1)}ms`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

async function run() {
  const fileSize = sizeMB * 1024 * 1024;
  console.log(`[client] creating ${sizeMB}MB file...`);
  const file = makeFile(fileSize);

  const encryptionKey = encrypted ? await generateEncryptionKey() : undefined;

  console.log(`[client] fetching token...`);
  const token = await fetchToken();

  console.log(`[client] connecting to ${serverUrl}...`);
  const connection = new Connection({
    url: `${serverUrl}/?token=${token}`,
    transports: [websocketTransport({ timeout: 10000 })],
  });

  await connection.connected;
  console.log(`[client] connected`);

  const provider = new Provider({
    connection,
    document: "bench-doc",
    encryptionKey: encryptionKey ?? false,
    enableOfflinePersistence: false,
    rpc: {
      file: () => createFileRpc({ encryptionKey }),
    },
  });

  await provider.synced;
  console.log(`[client] synced, starting upload...`);

  const t0 = performance.now();
  const fileId = await provider.rpc.file.upload(file, { encryptionKey });
  const elapsed = performance.now() - t0;

  const throughput = fileSize / (elapsed / 1000);

  console.log(`[client] upload complete`);
  console.log(`  file_id:    ${fileId}`);
  console.log(`  size:       ${formatBytes(fileSize)}`);
  console.log(`  encrypted:  ${encrypted}`);
  console.log(`  time:       ${formatDuration(elapsed)}`);
  console.log(`  throughput: ${formatBytes(throughput)}/s`);

  // Output machine-readable result
  console.log(
    `\n__RESULT__ ${JSON.stringify({ sizeMB, encrypted, elapsedMs: elapsed, throughputMBps: throughput / (1024 * 1024) })}`,
  );

  await provider.flush();
  provider.destroy();
  process.exit(0);
}

run().catch((err) => {
  console.error("[client] fatal:", err);
  process.exit(1);
});
