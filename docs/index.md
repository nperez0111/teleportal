---
# https://vitepress.dev/reference/default-theme-home-page
layout: home

hero:
  name: "Teleportal"
  text: "Build your own Y.js sync server"
  tagline: Storage, transport & runtime agnostic. Any storage, any JS runtime, any transport.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/nperez0111/teleportal

features:
  - title: 💾 Storage Agnostic
    details: Store documents in Redis, PostgreSQL, S3, or any backend. Completely decoupled storage with swappable implementations.
  - title: 🔄 Transport Flexible
    details: Use WebSockets, HTTP, SSE, or any transport. Built on web standard streams with Uint8Array encoding.
  - title: 🏃 Runtime Independent
    details: Works on Node.js, Bun, Deno, or any JavaScript runtime. Built on web primitives with minimal dependencies.
  - title: 📁 Sub-docs Support
    details: Full support for Y.js subdocuments. One of the few providers that implements this feature completely.
  - title: 🏎️ Zero In-Memory Storage
    details: Documents are never stored in memory on the server, making it perfect for scalable deployments.
  - title: 🔐 End-to-End Encryption
    details: Optional E2EE support with AES-GCM encryption, key management, and encrypted file transfers.
---

