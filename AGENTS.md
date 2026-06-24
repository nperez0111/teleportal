---
description: Project index for the Teleportal Y.js Sync Server
alwaysApply: true
---

# Project index

This document serves as an index for all specifications in this project.

## Context

This project is a Y.js Sync Server. It is designed to be a flexible, extensible, and easy-to-use library for building a "sync server" for Y.js. A "sync server" is a server that can sync Y.js documents between clients. Teleportal aims to be a general purpose framework for building sync servers for Y.js. It is designed to be storage, transport, and JS runtime agnostic. We always use JS native APIs and Bun as the JS runtime, package manager, and build tool.

The project is experimental, and the API is subject to change. WE DO NOT NEED BACKWARD COMPATIBILITY.

## Sub-packages

There are several sub-packages built with documentation:

- [`teleportal/storage`](./src/storage/README.md) - Storage interfaces and implementations
- [`teleportal/http`](./src/http/README.md) - HTTP handlers
- [`teleportal/protocol`](./src/lib/protocol/README.md) - Protocol encoding/decoding
- [`teleportal/protocol/encryption`](./src/lib/protocol/encryption/README.md) - Encryption protocol
- [`teleportal/attribution`](./src/lib/attribution/README.md) - Attribution data model, set operations, and encoding
- [`teleportal/protocols/attribution`](./src/protocols/attribution/README.md) - Attribution (authorship) read RPC methods
- [`teleportal/providers`](./src/providers/README.md) - Provider and connection architecture
- [`teleportal/transports`](./src/transports/README.md) - Transport middleware
- [`teleportal/token`](./src/token/README.md) - JWT token utilities
- [`teleportal/encryption-key`](./src/encryption-key/README.md) - Encryption key utilities
- [`teleportal/monitoring`](./src/monitoring/README.md) - Metrics and monitoring (prometheus & HTTP endpoints)
- [`teleportal/devtools`](./src/devtools/README.md) - DevTools integration

## Code Context

- Running the project: `bun run dev` (bun dev server)
- Running all the tests: `bun run test` (type check & bun test runner)
- Checking the lint & formatting: `bun run lint` (report)
- Fixing the lint & formatting: `bun run lint:fix` (fix)
- Type checking: `bun run test:types` (oxlint + tsgo via `vp check`)
- A goal of this project is to have the minimum number of dependencies and to be as small as possible, so avoid adding dependencies unless otherwise specified
- When fixing a bug, add a corresponding test case to prevent regression if reasonable to do so
- Prefer a red-green-refactor cycle: before implementing a fix, write a test that captures the expected behavior and confirm it fails (red). Only then implement the fix to make the test pass (green). This forces you to articulate your expectations upfront rather than acting on a hunch. It doesn't need to slow you down — treat it as a thinking tool that clarifies what "correct" means before you start changing code.
- Use minimal timeouts in tests to keep the suite fast. Prefer event-driven waits (polling until a condition is met) over fixed-duration sleeps. When a sleep is unavoidable (e.g. waiting for a TTL to expire), set the TTL/interval to 1ms and sleep just long enough (e.g. 5ms). Never use `setTimeout(resolve, 20)` or higher as a generic "wait for async processing" — use `setTimeout(resolve, 1)` or `setTimeout(resolve, 0)` instead.
