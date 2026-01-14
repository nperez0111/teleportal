# Getting Started

Teleportal is a **storage, transport & runtime agnostic Y.js server/provider**. It allows you to build collaborative applications with Y.js while maintaining complete flexibility over your infrastructure choices.

## What is Teleportal?

Teleportal provides:

- **Y.js Server**: A server implementation that handles Y.js document synchronization
- **Y.js Provider**: Client-side providers that connect to the server
- **Flexible Storage**: Store documents in any backend (Redis, PostgreSQL, S3, etc.)
- **Flexible Transport**: Use WebSockets, HTTP, SSE, or any transport mechanism
- **Runtime Agnostic**: Works on Node.js, Bun, Deno, or any JavaScript runtime

## Key Features

### 🌏 Ease-of-use

We won't make you learn what a Y.Doc is, and make you store it somewhere, keep an instance of the provider, and you'll have everything you need!

### 📁 Sub-docs

Full support for Y.js subdocs - there aren't many providers out there which have implemented this, this one does 😉

### 🏎️ Performance

Built on top of web-native Streams APIs, supporting control-flow, backpressure. All without actually storing the documents in-memory.

### 🔄 Zero in-memory storage

Documents are never stored in memory on the server, making it perfect for scalable deployments.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      Client Application                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │   Y.Doc      │  │  Provider    │  │  Connection  │       │
│  └──────────────┘  └──────────────┘  └──────────────┘       │
└─────────────────────────────────────────────────────────────┘
                             │
                             │ WebSocket/HTTP/SSE
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                      Teleportal Server                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │   Server     │  │  Transport   │  │   Storage    │       │
│  └──────────────┘  └──────────────┘  └──────────────┘       │
└─────────────────────────────────────────────────────────────┘
                             │
                             │ Storage Interface
                             ▼
                    ┌─────────────────┐
                    │  Redis / DB /   │
                    │  S3 / etc.      │
                    └─────────────────┘
```

## Core Concepts

### Server

The `Server` class manages document sessions, client connections, and coordinates synchronization. It's storage-agnostic and works with any storage backend.

### Provider

The `Provider` class manages Y.js document synchronization on the client side. It handles connection management, offline persistence, and awareness updates.

### Storage

Storage is completely decoupled from the library. You can implement storage for any backend by implementing the storage interfaces.

### Transport

Transport handles the communication layer. Teleportal works with WebSockets, HTTP, SSE, or any bidirectional communication mechanism.

## Next Steps

- [Installation](./installation.md) - Install Teleportal
- [Quick Start](./quick-start.md) - Get up and running quickly
- [Server Setup](./server-setup.md) - Learn how to set up the server
- [Provider Setup](./provider-setup.md) - Learn how to use the client provider
