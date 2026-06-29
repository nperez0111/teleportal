/**
 * Runner script: starts the server, runs the client, reports results.
 *
 * Usage:
 *   bun run benchmarks/file-upload-real/run.ts [--size 100] [--encrypted] [--unstorage] [--rate-limit]
 */
import { $ } from "bun";

const args = process.argv.slice(2);

function getArg(name: string, defaultValue: string): string {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return defaultValue;
  return args[idx + 1] ?? defaultValue;
}

const sizeMB = Number(getArg("size", "100"));
const encrypted = !args.includes("--no-encrypt");
const unstorage = args.includes("--unstorage");
const rateLimit = args.includes("--rate-limit");
const port = 9877 + Math.floor(Math.random() * 100);

console.log("═══════════════════════════════════════════════════");
console.log("  File Upload Real E2E Benchmark");
console.log("═══════════════════════════════════════════════════");
console.log(`  Size:        ${sizeMB} MB`);
console.log(`  Encrypted:   ${encrypted}`);
console.log(`  Storage:     ${unstorage ? "unstorage (memory driver)" : "in-memory"}`);
console.log(`  Rate limit:  ${rateLimit}`);
console.log(`  Port:        ${port}`);
console.log("═══════════════════════════════════════════════════\n");

const serverArgs = [
  "run",
  "--bun",
  import.meta.dir + "/server.ts",
  ...(unstorage ? ["--unstorage"] : []),
  ...(rateLimit ? ["--rate-limit"] : []),
];

const serverProc = Bun.spawn(["bun", ...serverArgs], {
  env: { ...process.env, BENCH_PORT: String(port) },
  stdout: "inherit",
  stderr: "inherit",
});

// Wait for server to be ready
let ready = false;
for (let i = 0; i < 50; i++) {
  try {
    const res = await fetch(`http://localhost:${port}/health`);
    if (res.ok) {
      ready = true;
      break;
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 100));
}

if (!ready) {
  console.error("Server failed to start");
  serverProc.kill();
  process.exit(1);
}

console.log("[runner] server ready, starting client...\n");

const clientProc = Bun.spawn(
  ["bun", "run", "--bun", import.meta.dir + "/client.ts"],
  {
    env: {
      ...process.env,
      BENCH_PORT: String(port),
      BENCH_SIZE_MB: String(sizeMB),
      BENCH_ENCRYPTED: String(encrypted),
    },
    stdout: "pipe",
    stderr: "inherit",
  },
);

const output = await new Response(clientProc.stdout).text();
console.log(output);

const exitCode = await clientProc.exited;

// Parse result
const resultLine = output.split("\n").find((l) => l.startsWith("__RESULT__"));
if (resultLine) {
  const result = JSON.parse(resultLine.replace("__RESULT__ ", ""));
  console.log("───────────────────────────────────────────────────");
  console.log(`  Result: ${result.sizeMB}MB in ${(result.elapsedMs / 1000).toFixed(2)}s`);
  console.log(`  Throughput: ${result.throughputMBps.toFixed(1)} MB/s`);
  const target = 500;
  const goalMet = result.elapsedMs <= target;
  if (result.sizeMB === 100) {
    console.log(`  Goal (100MB < ${target}ms): ${goalMet ? "✓ PASS" : "✗ FAIL"}`);
  }
  console.log("───────────────────────────────────────────────────");
}

serverProc.kill();
process.exit(exitCode);
