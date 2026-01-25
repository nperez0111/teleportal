What is Teleportal?

Teleportal is a real-time collaborative editing **framework** built on Y.js. This means that it is a library for synchronizing Y.js documents between clients, enabling collaborative editing like Google Docs, Notion and Figma.

---

Framework:

Notes: Teleportal is designed to be a framework, it is not some monolithic server that you have to deploy and manage. Instead, it is a library of components that you can use to build collaborative editing into your application.

Slide Content: Diagram of components of the framework and how they fit together.

- Protocol (teleportal)
  - Messages that go through transports
- Transports (teleportal/transports)
  - Pipe messages through middleware like encryption, rate limiting, logging, validation, etc.
- Authentication/Authorization (teleportal/token)
  - JWT token authn/authz for validation on every message
- Monitoring (teleportal/monitoring)
  - Server monitoring, status, metrics, health checks
- Storage (teleportal/storage)
  - Store documents, files, milestones to any storage backend
- Server (teleportal/server)
  - Connect clients to documents through shared sessions
  - pub-sub for coordinating between server instances
- WebSocket (teleportal/websocket-server)
  - Use WebSocket for transporting messages between clients and servers
- HTTP (teleportal/http)
  - Use HTTP/SSE for transporting messages between clients and servers
- Providers (teleportal/providers)
  - Harness for a ydoc and awareness, multiple providers share the same connection
- DevTools (teleportal/devtools)
  - Inspect messages & connection status in the browser
- RPC
  - File Transfer (teleportal/protocols/file)
  - Milestone (teleportal/protocols/milestone)

---

It'd be difficult to go over all of the components in detail, but this is just to give you an idea of the architecture and how the pieces fit together. Here are some of the key design choices made upfront when building Teleportal:

- Storage agnostic (KV, Relational, S3, etc.)
- Runtime agnostic (built on web standards, minimal dependencies)
- Transport agnostic (use any transport you like, HTTP, WebSocket, SSE, etc.)
- Framework agnostic (no frontend, just JavaScript)
- End-to-end encryption by default (not complete, but it does work!)

[I actually posted this on Bluesky here](https://bsky.app/profile/nickthesick.com/post/3lpvove2dvk23)

---

There are a couple of cool things about Teleportal that I want to highlight:

I built Teleportal knowing that I would want to swap out the connection layer, so I made it so that you can use any transport you like, HTTP, WebSocket, SSE, etc. One cool thing this enabled is that now, I can try a WebSocket connection, and if it fails to connect (like in a corporate environment where WebSocket is blocked), I can fall back to HTTP & SSE. This is the sort of thing that I handle for you with Teleportal, and many monolithic sync servers can't or you would have to wait for them to implement it, but with Teleportal, you can implement this yourself!

---

The other cool thing I wanted to highlight with Teleportal is that I built an RPC system into the protocol, so there are two extensions to the protocol that I've built that would be useful for many applications:

- File Transfer (teleportal/protocols/file)
  - Chunked file transfer with Merkle tree verification
- Milestones (teleportal/protocols/milestone)
  - Capture document snapshots to see what a document looked like at a point in time
- With Y.js 14, we can also do attribution tracking to see who made what changes to a document

---

Closing thoughts:

Teleportal is a work in progress, but I'm very excited to see where it goes. I'm hoping that it becomes the _de facto_ Y.js sync server for web applications.
