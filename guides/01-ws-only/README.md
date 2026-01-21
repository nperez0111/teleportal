# WebSocket Only

This guide demonstrates a minimal Teleportal server setup using only WebSocket connections. The server uses in-memory storage and accepts all WebSocket upgrade requests.

## What it demonstrates

- Setting up a basic Teleportal server with WebSocket transport only
- Using in-memory `YDocStorage` for document storage
- Handling WebSocket upgrades with context extraction
- Client connection using the `Provider` API with WebSocket transport
