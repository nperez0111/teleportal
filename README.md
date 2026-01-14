# TelePortal

<img align="right" src="./assets/pepper.png?raw=true" height="240" />

> TelePortal: A storage, transport & runtime agnostic Y.js server/provider. Built on web primitives, supports subdocs, and handles everything without in-memory storage. Perfect for collaborative apps! 🚀

This is a **Y.js Server & Provider** that aims to be storage, transport, and runtime agnostic.

* **💾 Storage:** Storage is completely de-coupled from the library, you can store documents in a KV, relational database or even S3, totally up to you

  * Currently this is implemented with `unstorage` which can swap out drivers for many different storage schemes.

* **🔄 Transport:** everything is defined using Web standard streams and encodes to a `Uint8Array`

  * Use Websockets, HTTP, HTTP + SSE, anything you like that can fulfill a bidirectional communication

* **🏃 Runtime:** built on web primitives, everything should work on any JavaScript runtime, with minimal dependencies

## Features

* **🌏 Ease-of-use:** We won't make you learn what a Y.Doc is, and make you store it somewhere, keep an instance of the provider, and you'll have everything you need!

* **📁 Sub-docs:** There aren't many providers out there which have implemented Y.js subdocs, this one does 😉

* **🏎️ Performance:** This is all built on top of web-native Streams APIs, supporting control-flow, backpressure. All without actually storing the documents in-memory

![teleportal demo video](./assets/teleportal.mp4)

<!-- automd:badges color=yellow -->

[![npm version](https://img.shields.io/npm/v/teleportal?color=yellow)](https://npmjs.com/package/teleportal)
[![npm downloads](https://img.shields.io/npm/dm/teleportal?color=yellow)](https://npm.chart.dev/teleportal)

<!-- /automd -->

[yjs](https://docs.yjs.dev/) server that is storage agnostic, protocol agnostic, and transport agnostic.

Supports:

* Rooms
* Documents
* Y.js awareness

> [!NOTE]
> 🚧 This is still a work in progress. Feedback and contributions are welcome!
