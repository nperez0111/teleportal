# HTTP Only

This guide demonstrates a Teleportal server setup using only HTTP connections (Server-Sent Events). WebSocket upgrades are explicitly refused, forcing clients to use HTTP transport.

## What it demonstrates

- Setting up a Teleportal server with HTTP transport only
- Disabling WebSocket upgrades by throwing an error in the upgrade handler
- Using Server-Sent Events (SSE) for real-time synchronization
- Client connection using the `Provider` API with HTTP transport and EventSource polyfill
