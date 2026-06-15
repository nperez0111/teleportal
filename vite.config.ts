import { defineConfig } from "vite-plus";

export default defineConfig({
  lint: {
    rules: {
      "unicorn/no-null": "off",
      "typescript/no-empty-object-type": "off",
      "typescript/no-non-null-asserted-optional-chain": "off",
    },
    ignorePatterns: ["dist/**"],
  },
  pack: {
    entry: {
      "lib/index": "src/lib/index.ts",
      "storage/index": "src/storage/index.ts",
      "http/index": "src/http/index.ts",
      "lib/protocol/index": "src/lib/protocol/index.ts",
      "protocols/milestone/index": "src/protocols/milestone/index.ts",
      "protocols/file/index": "src/protocols/file/index.ts",
      "lib/protocol/encryption/index": "src/lib/protocol/encryption/index.ts",
      "providers/index": "src/providers/index.ts",
      "transports/redis/index": "src/transports/redis/index.ts",
      "transports/nats/index": "src/transports/nats/index.ts",
      "transports/rate-limiter/index": "src/transports/rate-limiter/index.ts",
      "transports/index": "src/transports/index.ts",
      "websocket-server/index": "src/websocket-server/index.ts",
      "server/index": "src/server/index.ts",
      "monitoring/index": "src/monitoring/index.ts",
      "encryption-key/index": "src/encryption-key/index.ts",
      "token/index": "src/token/index.ts",
      "merkle-tree/index": "src/merkle-tree/index.ts",
      "devtools/index": "src/devtools/index.ts",
      "agent/index": "src/agent/index.ts",
    },
    format: ["esm"],
    dts: true,
    outDir: "dist",
  },
});
