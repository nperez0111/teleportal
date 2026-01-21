# Simple Fallback

This guide demonstrates a Teleportal server that supports both WebSocket and HTTP transports, with the client automatically falling back to HTTP if WebSocket connection fails.

## What it demonstrates

- Setting up a Teleportal server that supports both WebSocket and HTTP transports
- Conditional WebSocket upgrade acceptance based on query parameters
- Client-side automatic fallback from WebSocket to HTTP transport
- Using the `connectionType` property to determine which transport is active
