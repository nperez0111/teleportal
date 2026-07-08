/**
 * End-to-end check against a running `wrangler dev` (default port 8787).
 * Usage: bun run scripts/e2e.ts [base-url]
 */
import { EventSource } from "eventsource";
import {
  type ConnectionTransport,
  httpTransport,
  Provider,
  websocketTransport,
} from "teleportal/providers";

const base = process.argv[2] ?? "http://localhost:8787";
const url = `${base}/api`;

async function roundTrip(name: string, transports: ConnectionTransport[]) {
  const docName = `e2e-${name}-${Date.now()}`;

  const writer = await Provider.create({
    url,
    document: docName,
    transports,
    encryptionKey: false,
  });
  writer.doc.getText("t").insert(0, `hello via ${name}`);
  await writer.synced;
  await writer.flush();
  await writer.destroy();

  const reader = await Provider.create({
    url,
    document: docName,
    transports,
    encryptionKey: false,
  });
  await reader.synced;
  const text = reader.doc.getText("t").toString();
  await reader.destroy();

  if (text !== `hello via ${name}`) {
    throw new Error(`${name}: expected "hello via ${name}", got "${text}"`);
  }
  console.log(`✔ ${name} round-trip + persistence`);
}

const health = await fetch(`${base}/api/health`);
if (!health.ok) throw new Error(`health: ${health.status}`);
console.log("✔ health");

await roundTrip("websocket", [websocketTransport({ timeout: 5000 })]);
await roundTrip("sse", [httpTransport({ EventSource })]);
console.log("all good");
process.exit(0);
