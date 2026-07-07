# Changelog

## v0.0.5

[compare changes](https://github.com/nperez0111/teleportal/compare/v0.0.4...v0.0.5)

### 🚀 Enhancements

- Upgrade to logtape 2 & emit wide events ([#56](https://github.com/nperez0111/teleportal/pull/56))
- Attribution storage, read RPC protocol, and milestone attribution ([#69](https://github.com/nperez0111/teleportal/pull/69))
- Cluster-aware presence protocol with crash-safe awareness clearing ([#68](https://github.com/nperez0111/teleportal/pull/68))
- Client flow control non-fatal rate limiting, ACK timeout, update batching ([#72](https://github.com/nperez0111/teleportal/pull/72))
- Versioned update wire protocol (V1/V2) + dependency upgrades ([#73](https://github.com/nperez0111/teleportal/pull/73))
- Custom attribution metadata, encrypted-doc attribution, and unified RPC permissions ([#74](https://github.com/nperez0111/teleportal/pull/74))
- Refactor provider/connection to pluggable transport architecture with RPC extensions ([#75](https://github.com/nperez0111/teleportal/pull/75))
- Content-level encryption for Y.js updates ([d6f7725](https://github.com/nperez0111/teleportal/commit/d6f7725))
- Unified storage API and content-level encryption refinements ([a97cf44](https://github.com/nperez0111/teleportal/commit/a97cf44))
- Automatic sidecar compaction with hash-based verification ([57bbb1a](https://github.com/nperez0111/teleportal/commit/57bbb1a))
- Encrypted offline persistence at rest via IndexedDB ([585f3db](https://github.com/nperez0111/teleportal/commit/585f3db))
- **encryption:** Keyed PRF for metadata tokens + document threat model (3C/3A) ([7633163](https://github.com/nperez0111/teleportal/commit/7633163))
- **rpc:** Add RPC framework with defineMethod/defineProtocol/createHandlers/createClientExtension ([a613f4f](https://github.com/nperez0111/teleportal/commit/a613f4f))
- **file:** Client-side IDB cache, resumable uploads, rate-limit retransmission ([bb2e88d](https://github.com/nperez0111/teleportal/commit/bb2e88d))
- **storage:** Add TieredDocumentStorage for yhub-style two-tier caching ([e82e657](https://github.com/nperez0111/teleportal/commit/e82e657))
- **encryption-key:** Add key distribution system with registry, wrapping, and HTTP management ([553980f](https://github.com/nperez0111/teleportal/commit/553980f))
- **providers:** Transport upgrade probe with exponential backoff ([27b9f82](https://github.com/nperez0111/teleportal/commit/27b9f82))
- **devtools:** Add transport toggle and fix SSE error handling ([5eaedc5](https://github.com/nperez0111/teleportal/commit/5eaedc5))
- **storage:** Add UnstorageKeyRegistryStorage for persistent key distribution ([78fbf68](https://github.com/nperez0111/teleportal/commit/78fbf68))
- **benchmarks:** Migrate to tinybench and add comprehensive benchmark suites ([808242a](https://github.com/nperez0111/teleportal/commit/808242a))
- **providers:** SharedWorker connection offload + file-upload perf overhaul ([#83](https://github.com/nperez0111/teleportal/pull/83))
- Postgres/S3 storage, resumable file uploads, pooled SharedWorker connections, and hardening ([#85](https://github.com/nperez0111/teleportal/pull/85))

### 🔥 Performance

- **storage:** Skip parseUpdateMetaV2 for unencrypted docs, eliminate tiered delegation overhead ([e0a1dcd](https://github.com/nperez0111/teleportal/commit/e0a1dcd))
- **encryption:** Parallelize crypto ops and reduce allocations ([f0f7a11](https://github.com/nperez0111/teleportal/commit/f0f7a11))
- Optimize encryption pipeline, merkle hashing, and transport middleware ([46bbb4d](https://github.com/nperez0111/teleportal/commit/46bbb4d))
- **devtools:** Eliminate DOM thrashing with incremental rendering ([0e7a91c](https://github.com/nperez0111/teleportal/commit/0e7a91c))
- **connection:** Reduce timer thrashing and event dispatch overhead ([e796cb5](https://github.com/nperez0111/teleportal/commit/e796cb5))

### 🩹 Fixes

- Slightly better reconnection logic for websockets ([3c3709d](https://github.com/nperez0111/teleportal/commit/3c3709d))
- E2EE milestone snapshot decryption + attribution range data loss ([#71](https://github.com/nperez0111/teleportal/pull/71))
- Address review findings in content-encryption + offline persistence ([e9351e3](https://github.com/nperez0111/teleportal/commit/e9351e3))
- **ydoc:** Swallow unhandled rejection from abandoned synced promise ([c449157](https://github.com/nperez0111/teleportal/commit/c449157))
- **playground:** Make editor fill available vertical space ([5be8e2b](https://github.com/nperez0111/teleportal/commit/5be8e2b))
- **http:** Wire withAckSink into SSE reader so writer ACKs resolve ([ffc794b](https://github.com/nperez0111/teleportal/commit/ffc794b))
- **storage:** Persist delete-only updates instead of discarding them ([dee9b85](https://github.com/nperez0111/teleportal/commit/dee9b85))
- **build:** Add explicit type annotation for teleportalEventClient to fix DTS generation ([6fd8f5b](https://github.com/nperez0111/teleportal/commit/6fd8f5b))
- **build:** Add missing key-wrapping and key-resolver modules ([20fa0b1](https://github.com/nperez0111/teleportal/commit/20fa0b1))
- **key-registry:** Fix encryption mismatch and multi-client key sharing ([f9c89f2](https://github.com/nperez0111/teleportal/commit/f9c89f2))
- **playground:** Share URL for registry-encrypted docs signals encryption ([0927692](https://github.com/nperez0111/teleportal/commit/0927692))
- **file:** Use ENCRYPTED_CHUNK_SIZE for upload size calculation ([95ab202](https://github.com/nperez0111/teleportal/commit/95ab202))
- Resolve type errors in benchmarks helpers, file handler tests, and merkle tree ([74603ec](https://github.com/nperez0111/teleportal/commit/74603ec))
- Resolve CI failures — benchmark timeouts, ACK margin, and destroyed connection leak ([33d983a](https://github.com/nperez0111/teleportal/commit/33d983a))
- **ci:** Rename benchmarks to .bench.ts and silently drop sends on destroyed connections ([383693a](https://github.com/nperez0111/teleportal/commit/383693a))

### 💅 Refactors

- **encryption:** Store sidecar itemLength explicitly (2B) ([62b0548](https://github.com/nperez0111/teleportal/commit/62b0548))
- **provider:** Replace fan-in stream with a serial apply queue (1B) ([0851796](https://github.com/nperez0111/teleportal/commit/0851796))
- **encryption:** Compute sidecar compaction lazily at send time ([0d64752](https://github.com/nperez0111/teleportal/commit/0d64752))
- **transports:** Migrate stream plumbing to teleportal/iter ([509bb55](https://github.com/nperez0111/teleportal/commit/509bb55))
- **merkle-tree:** Replace TransformStream with async generator ([6276491](https://github.com/nperez0111/teleportal/commit/6276491))
- **storage:** Merge-on-read architecture with pending update log ([f025ffa](https://github.com/nperez0111/teleportal/commit/f025ffa))

### 📖 Documentation

- Single file demo ([46694e8](https://github.com/nperez0111/teleportal/commit/46694e8))
- More examples ([2bfe646](https://github.com/nperez0111/teleportal/commit/2bfe646))
- Add kitchen sink example ([eabba8e](https://github.com/nperez0111/teleportal/commit/eabba8e))
- Update FOSDEM link ([2d79571](https://github.com/nperez0111/teleportal/commit/2d79571))
- Use blog post ([3792006](https://github.com/nperez0111/teleportal/commit/3792006))
- Add npmx.dev badges and Y.js storage agent skill ([#62](https://github.com/nperez0111/teleportal/pull/62))
- Add key registry protocol and key wrapping documentation ([665bc20](https://github.com/nperez0111/teleportal/commit/665bc20))
- **guides:** Add rate limit and message size exceeded callbacks ([ab87d33](https://github.com/nperez0111/teleportal/commit/ab87d33))

### 📦 Build

- Migrate to obuild/rolldown ([#55](https://github.com/nperez0111/teleportal/pull/55))

### 🏡 Chore

- Minor change ([293f038](https://github.com/nperez0111/teleportal/commit/293f038))
- Og meta ([6b46a02](https://github.com/nperez0111/teleportal/commit/6b46a02))
- Add new simple example ([9a21321](https://github.com/nperez0111/teleportal/commit/9a21321))
- Add more TODOs ([1488dda](https://github.com/nperez0111/teleportal/commit/1488dda))
- Bump packages ([6f9eb0b](https://github.com/nperez0111/teleportal/commit/6f9eb0b))
- Add Dockerfile for cloud agents ([ae22299](https://github.com/nperez0111/teleportal/commit/ae22299))
- Update dependencies to latest versions ([#58](https://github.com/nperez0111/teleportal/pull/58))
- Upgrade logtape, hookable, and devtools event client ([#61](https://github.com/nperez0111/teleportal/pull/61))
- Fix formatting and update vite-plus to 0.2.1 ([910acec](https://github.com/nperez0111/teleportal/commit/910acec))
- Minor playground updates ([e3b7be2](https://github.com/nperez0111/teleportal/commit/e3b7be2))
- Benchmarks suite ([963c454](https://github.com/nperez0111/teleportal/commit/963c454))

### ✅ Tests

- Lock in VirtualStorage attribution capability + batching ([#70](https://github.com/nperez0111/teleportal/pull/70))
- Harden content restore + sidecar merge, expand subsystem test coverage ([bab1a69](https://github.com/nperez0111/teleportal/commit/bab1a69))
- **storage:** Add recovery and correctness tests for TieredDocumentStorage ([4f9e856](https://github.com/nperez0111/teleportal/commit/4f9e856))
- **key-registry:** Add key distribution integration test ([30c7927](https://github.com/nperez0111/teleportal/commit/30c7927))

### 🎨 Styles

- Formatting and lint cleanup ([3c3d61c](https://github.com/nperez0111/teleportal/commit/3c3d61c))
- Apply formatter across benchmarks, docs, and source files ([ad1d13d](https://github.com/nperez0111/teleportal/commit/ad1d13d))

### 🤖 CI

- Add dependabot, harden and update GitHub Actions ([f48d4b6](https://github.com/nperez0111/teleportal/commit/f48d4b6))

### ❤️ Contributors

- Nick Perez ([@nperez0111](https://github.com/nperez0111))
- Nick The Sick ([@nperez0111](https://github.com/nperez0111))
- Pooya Parsa <pyapar@gmail.com>

## v0.0.4

[compare changes](https://github.com/nperez0111/teleportal/compare/v0.0.3...v0.0.4)

### 🚀 Enhancements

- **http:** Passthrough fetch handler ([2536df4](https://github.com/nperez0111/teleportal/commit/2536df4))

### 📖 Documentation

- Text with logo ([bc83b4c](https://github.com/nperez0111/teleportal/commit/bc83b4c))

### ❤️ Contributors

- Nick The Sick ([@nperez0111](https://github.com/nperez0111))

## v0.0.3

[compare changes](https://github.com/nperez0111/teleportal/compare/v0.0.2...v0.0.3)

## v0.0.2

### 🚀 Enhancements

- Initial commit ([d104d25](https://github.com/nperez0111/teleportal/commit/d104d25))
- Sendable messages as classes, strictly use updatev2 format ([a8dd6a5](https://github.com/nperez0111/teleportal/commit/a8dd6a5))
- Sending messages between clients ([940d483](https://github.com/nperez0111/teleportal/commit/940d483))
- Simple provider implementation ([87dffe8](https://github.com/nperez0111/teleportal/commit/87dffe8))
- Support for subdocs ([914f2c7](https://github.com/nperez0111/teleportal/commit/914f2c7))
- Pings & pongs ([eb07b28](https://github.com/nperez0111/teleportal/commit/eb07b28))
- Compaction on unload ([cd16553](https://github.com/nperez0111/teleportal/commit/cd16553))
- Allow opening a doc from a provider ([333f85d](https://github.com/nperez0111/teleportal/commit/333f85d))
- Configurable provider, wait for document full-sync ([b85ab22](https://github.com/nperez0111/teleportal/commit/b85ab22))
- Support encrypted messages at the protocol level ([e7a25f8](https://github.com/nperez0111/teleportal/commit/e7a25f8))
- Support for e2ee ([2755123](https://github.com/nperez0111/teleportal/commit/2755123))
- Node implementation ([d330f05](https://github.com/nperez0111/teleportal/commit/d330f05))
- Organization & token sub-package ([4cdac3f](https://github.com/nperez0111/teleportal/commit/4cdac3f))
- More ergonomic token handling ([07c6ed0](https://github.com/nperez0111/teleportal/commit/07c6ed0))
- Implement auth message ([781dc8e](https://github.com/nperez0111/teleportal/commit/781dc8e))
- Test with encrypted server ([7ce847e](https://github.com/nperez0111/teleportal/commit/7ce847e))
- Rename, better websocket connection manager ([8886ed8](https://github.com/nperez0111/teleportal/commit/8886ed8))
- New playground frontend ([23d6321](https://github.com/nperez0111/teleportal/commit/23d6321))
- Rename to teleportal ([9467c50](https://github.com/nperez0111/teleportal/commit/9467c50))
- Much better demo ([fbd9ece](https://github.com/nperez0111/teleportal/commit/fbd9ece))
- Switch docs but still allow configuring the transport ([e8225d0](https://github.com/nperez0111/teleportal/commit/e8225d0))
- Add query awareness message ([2e43048](https://github.com/nperez0111/teleportal/commit/2e43048))
- Load test script ([0705349](https://github.com/nperez0111/teleportal/commit/0705349))
- Implement `sync-done` message ([48990a0](https://github.com/nperez0111/teleportal/commit/48990a0))
- Background sync with redis ([c2450ac](https://github.com/nperez0111/teleportal/commit/c2450ac))
- Enable offline persistance with y-indexeddb ([ded7a25](https://github.com/nperez0111/teleportal/commit/ded7a25))
- Add http transport ([7d93f8b](https://github.com/nperez0111/teleportal/commit/7d93f8b))
- Add pubsub sink and source ([#6](https://github.com/nperez0111/teleportal/pull/6))
- Fan-in reader ([#10](https://github.com/nperez0111/teleportal/pull/10))
- Implement http + sse transports ([#7](https://github.com/nperez0111/teleportal/pull/7))
- Http + sse provider connection ([#11](https://github.com/nperez0111/teleportal/pull/11))
- Transparent connection fallback ([#12](https://github.com/nperez0111/teleportal/pull/12))
- Add excalidraw demo ([#17](https://github.com/nperez0111/teleportal/pull/17))
- Add encryption state vector ([#14](https://github.com/nperez0111/teleportal/pull/14))
- Support NATS pub sub ([361401f](https://github.com/nperez0111/teleportal/commit/361401f))
- Server agents ([6032148](https://github.com/nperez0111/teleportal/commit/6032148))
- **server:** Server V2 ([#26](https://github.com/nperez0111/teleportal/pull/26))
- **file-uploads:** Add file-uploads & downloads to the protocol ([#30](https://github.com/nperez0111/teleportal/pull/30))
- Switch from loglayer -> logtape ([04f76c6](https://github.com/nperez0111/teleportal/commit/04f76c6))
- Encrypted file uploads & downloads ([8aa4769](https://github.com/nperez0111/teleportal/commit/8aa4769))
- Support Y.Doc `sync` event fixes #39 ([#39](https://github.com/nperez0111/teleportal/issues/39))
- Add support for milestones #22 ([#40](https://github.com/nperez0111/teleportal/pull/40), [#22](https://github.com/nperez0111/teleportal/issues/22))
- Ack every message & keep track of acks ([453e73f](https://github.com/nperez0111/teleportal/commit/453e73f))
- **virtual-storage:** Use tanstack pacer to batch writes to the underlying storage implementation ([6dee5ef](https://github.com/nperez0111/teleportal/commit/6dee5ef))
- Add metrics, status & health checks ([d0e7ca5](https://github.com/nperez0111/teleportal/commit/d0e7ca5))
- Better server events ([d6dd1a7](https://github.com/nperez0111/teleportal/commit/d6dd1a7))
- Better version management interface ([03e7401](https://github.com/nperez0111/teleportal/commit/03e7401))
- Devtools ([#46](https://github.com/nperez0111/teleportal/pull/46))
- Read more info from updates ([2edb7e1](https://github.com/nperez0111/teleportal/commit/2edb7e1))
- Add support for encryption at rest ([9b27feb](https://github.com/nperez0111/teleportal/commit/9b27feb))
- Rate-limiting & auto-snapshots ([3c10c64](https://github.com/nperez0111/teleportal/commit/3c10c64))
- **rpc-system:** De-tangle storage implementations & create an RPC system ([852d50f](https://github.com/nperez0111/teleportal/commit/852d50f))
- **e2ee:** Implement range-based set reconciliation ([9344df9](https://github.com/nperez0111/teleportal/commit/9344df9))
- **devtools:** Add a clear messages button ([bf000be](https://github.com/nperez0111/teleportal/commit/bf000be))
- **devtools:** Decrypt updates & display them ([44a398f](https://github.com/nperez0111/teleportal/commit/44a398f))
- Run the server on the client ([8a41b49](https://github.com/nperez0111/teleportal/commit/8a41b49))

### 🔥 Performance

- Dramatically improve de-encryption performance ([78533d7](https://github.com/nperez0111/teleportal/commit/78533d7))

### 🩹 Fixes

- Update protocol ([6f599a6](https://github.com/nperez0111/teleportal/commit/6f599a6))
- Send 404 ([4501348](https://github.com/nperez0111/teleportal/commit/4501348))
- Much more robust provider ([c43cd72](https://github.com/nperez0111/teleportal/commit/c43cd72))
- Allow all message types through ([e179e63](https://github.com/nperez0111/teleportal/commit/e179e63))
- Better error handling ([b27b421](https://github.com/nperez0111/teleportal/commit/b27b421))
- Better support for switching docs ([6c4e6e2](https://github.com/nperez0111/teleportal/commit/6c4e6e2))
- Minor cleanup ([c855f08](https://github.com/nperez0111/teleportal/commit/c855f08))
- Server tells you what document it is trying to open storage for ([219606c](https://github.com/nperez0111/teleportal/commit/219606c))
- Encrypted transport ignores updates to documents it does not own ([ed9d4dc](https://github.com/nperez0111/teleportal/commit/ed9d4dc))
- Have the server be compilable to a single file executable ([72d735b](https://github.com/nperez0111/teleportal/commit/72d735b))
- Add hooks ([3c89330](https://github.com/nperez0111/teleportal/commit/3c89330))
- Typo in pings in the protocol ([db7346f](https://github.com/nperez0111/teleportal/commit/db7346f))
- Ignore network condition when in local dev ([4a4e8bc](https://github.com/nperez0111/teleportal/commit/4a4e8bc))
- This binding ([3a297a4](https://github.com/nperez0111/teleportal/commit/3a297a4))
- Encrypted messaging again ([f4c268c](https://github.com/nperez0111/teleportal/commit/f4c268c))
- Implement sync-done for encrypted messages + cleanup ([c8e4af9](https://github.com/nperez0111/teleportal/commit/c8e4af9))
- Get provider to work offline again ([d0ad882](https://github.com/nperez0111/teleportal/commit/d0ad882))
- Clean up mobile styles ([9f6817a](https://github.com/nperez0111/teleportal/commit/9f6817a))
- Decryption transform only decrypts the doc it cares about ([95dd9b2](https://github.com/nperez0111/teleportal/commit/95dd9b2))
- Better fan-out writer ([a8e8894](https://github.com/nperez0111/teleportal/commit/a8e8894))
- Much better sub-doc support ([75193b7](https://github.com/nperez0111/teleportal/commit/75193b7))
- Clean up listener ([91dbb5e](https://github.com/nperez0111/teleportal/commit/91dbb5e))
- Downloads should be cached, even if the same request is made during download ([eb07943](https://github.com/nperez0111/teleportal/commit/eb07943))
- Actually upload the right file size ([d8a2fe9](https://github.com/nperez0111/teleportal/commit/d8a2fe9))
- Better ACK permission handling ([324ba34](https://github.com/nperez0111/teleportal/commit/324ba34))
- Remove dep on tanstack pacer ([c1a39fa](https://github.com/nperez0111/teleportal/commit/c1a39fa))
- Use pepper as favicon ([4c3ad1a](https://github.com/nperez0111/teleportal/commit/4c3ad1a))
- Simplify encryption at-rest for meta keys ([42e66f8](https://github.com/nperez0111/teleportal/commit/42e66f8))
- **sse:** Get SSe working again, cleanup API ([d4bd3fb](https://github.com/nperez0111/teleportal/commit/d4bd3fb))
- Clean up APIs ([b93fa9b](https://github.com/nperez0111/teleportal/commit/b93fa9b))

### 💅 Refactors

- Error handling for the encoder/decoders ([0f53de0](https://github.com/nperez0111/teleportal/commit/0f53de0))
- Minor changes ([0fc1bd5](https://github.com/nperez0111/teleportal/commit/0fc1bd5))
- Reogranize files ([0167c99](https://github.com/nperez0111/teleportal/commit/0167c99))
- Change logs ([e553e35](https://github.com/nperez0111/teleportal/commit/e553e35))
- Better separation of concerns ([ca26cb0](https://github.com/nperez0111/teleportal/commit/ca26cb0))
- Better organization for the protocol ([e2787b2](https://github.com/nperez0111/teleportal/commit/e2787b2))
- Abstract document-storage from low-level-document-storage ([3b77bcf](https://github.com/nperez0111/teleportal/commit/3b77bcf))
- Use hashes for message ids, re-use encoded values for perf ([93242f0](https://github.com/nperez0111/teleportal/commit/93242f0))
- Use package name internally ([d61a7b2](https://github.com/nperez0111/teleportal/commit/d61a7b2))
- Slightly better API ([2bc698a](https://github.com/nperez0111/teleportal/commit/2bc698a))
- Cleanup previous demo ([bfc55b3](https://github.com/nperez0111/teleportal/commit/bfc55b3))
- Move to folder structure, implement redis pubsub ([738fce4](https://github.com/nperez0111/teleportal/commit/738fce4))
- Switch from pino to using loglayer for independent logging ([ceccb21](https://github.com/nperez0111/teleportal/commit/ceccb21))
- Rewrite server for organization and simplicity ([80684a7](https://github.com/nperez0111/teleportal/commit/80684a7))
- Re-use same websocket connection across providers ([6116aea](https://github.com/nperez0111/teleportal/commit/6116aea))
- Have server emit events when clients and documents change ([071ea98](https://github.com/nperez0111/teleportal/commit/071ea98))
- Make the provider do the initial sync on initialization ([714ab45](https://github.com/nperez0111/teleportal/commit/714ab45))
- Rewrite server ([4c92c04](https://github.com/nperez0111/teleportal/commit/4c92c04))
- Migrate some more code over ([beace62](https://github.com/nperez0111/teleportal/commit/beace62))
- Move encryption logic into protocol ([a3e73bc](https://github.com/nperez0111/teleportal/commit/a3e73bc))
- Make permissioning optional ([d56572e](https://github.com/nperez0111/teleportal/commit/d56572e))
- Move message handler into document ([947423a](https://github.com/nperez0111/teleportal/commit/947423a))
- Use document.handleMessage for syncTransport ([58a6378](https://github.com/nperez0111/teleportal/commit/58a6378))
- Move protocol into lib and rename YTransport, YSink and YSource ([4837ce2](https://github.com/nperez0111/teleportal/commit/4837ce2))
- Use hookable-based `Observable` class ([92cc76c](https://github.com/nperez0111/teleportal/commit/92cc76c))
- Redis now based on pub-sub ([#15](https://github.com/nperez0111/teleportal/pull/15))
- Slightly more robust handling ([0582fc2](https://github.com/nperez0111/teleportal/commit/0582fc2))
- Use correct logtape format ([ac7e5d8](https://github.com/nperez0111/teleportal/commit/ac7e5d8))
- Rename EncryptedUpdate & DecryptedUpdate to EncryptedBinary & DecryptedBinary ([3e5caf7](https://github.com/nperez0111/teleportal/commit/3e5caf7))
- Slightly more robust provider & connection ([3aebe26](https://github.com/nperez0111/teleportal/commit/3aebe26))
- **merkle-tree:** Move merkle-tree to sub-dir ([5605ce4](https://github.com/nperez0111/teleportal/commit/5605ce4))

### 📖 Documentation

- Add tagline ([35fd6b4](https://github.com/nperez0111/teleportal/commit/35fd6b4))
- Better demo for encryption ([bde4683](https://github.com/nperez0111/teleportal/commit/bde4683))
- Make the demo work much better ([58aebce](https://github.com/nperez0111/teleportal/commit/58aebce))
- Add a README describing the protocol ([21ee797](https://github.com/nperez0111/teleportal/commit/21ee797))
- Add awareness request ([cc46f31](https://github.com/nperez0111/teleportal/commit/cc46f31))
- Describe the NATS main server ([039e7a3](https://github.com/nperez0111/teleportal/commit/039e7a3))
- Add pepper ([ce3e4c4](https://github.com/nperez0111/teleportal/commit/ce3e4c4))
- Add demo video to docs ([c99e3d9](https://github.com/nperez0111/teleportal/commit/c99e3d9))
- Update readme ([8dcb095](https://github.com/nperez0111/teleportal/commit/8dcb095))
- Update AGENTS.md ([f549d8c](https://github.com/nperez0111/teleportal/commit/f549d8c))
- Start on guides ([adbb3f3](https://github.com/nperez0111/teleportal/commit/adbb3f3))
- Add guide READMEs ([f76dc84](https://github.com/nperez0111/teleportal/commit/f76dc84))
- Couple more guides ([caa5fec](https://github.com/nperez0111/teleportal/commit/caa5fec))
- Init ([906137e](https://github.com/nperez0111/teleportal/commit/906137e))
- Some progress on the docs ([0ac20b5](https://github.com/nperez0111/teleportal/commit/0ac20b5))
- Update playground to hide sidebar if flaag ([20ac7a9](https://github.com/nperez0111/teleportal/commit/20ac7a9))
- Fixup the layout when in small window ([29109b2](https://github.com/nperez0111/teleportal/commit/29109b2))
- Better landing ([7b0a31c](https://github.com/nperez0111/teleportal/commit/7b0a31c))

### 📦 Build

- Make package buildable ([151a63d](https://github.com/nperez0111/teleportal/commit/151a63d))
- Just use bun for everything ([23e8e14](https://github.com/nperez0111/teleportal/commit/23e8e14))
- Docker builds for playground demo ([552ce6b](https://github.com/nperez0111/teleportal/commit/552ce6b))
- Auto-deploy ([51c34c3](https://github.com/nperez0111/teleportal/commit/51c34c3))
- Use https if needed ([8eada30](https://github.com/nperez0111/teleportal/commit/8eada30))
- Log at info ([777abaa](https://github.com/nperez0111/teleportal/commit/777abaa))
- Minor gitignore ([69e3999](https://github.com/nperez0111/teleportal/commit/69e3999))
- Point to correct built file ([674817f](https://github.com/nperez0111/teleportal/commit/674817f))
- Allow changes to lockfile ([7fc2720](https://github.com/nperez0111/teleportal/commit/7fc2720))
- Fix dockerfile for docs dir ([0756d96](https://github.com/nperez0111/teleportal/commit/0756d96))
- Docs deployment ([e2b6fc8](https://github.com/nperez0111/teleportal/commit/e2b6fc8))
- Add 404 page ([85aeec9](https://github.com/nperez0111/teleportal/commit/85aeec9))

### 🏡 Chore

- Update lockfile ([9cbc793](https://github.com/nperez0111/teleportal/commit/9cbc793))
- Update package.json ([b9fe549](https://github.com/nperez0111/teleportal/commit/b9fe549))
- Granular logging ([fae090c](https://github.com/nperez0111/teleportal/commit/fae090c))
- Architecture diagram ([eaad1eb](https://github.com/nperez0111/teleportal/commit/eaad1eb))
- Update tests ([295969c](https://github.com/nperez0111/teleportal/commit/295969c))
- Add powered-by ([8634b5f](https://github.com/nperez0111/teleportal/commit/8634b5f))
- Cleanup ([6b14bc3](https://github.com/nperez0111/teleportal/commit/6b14bc3))
- Publish rights ([69309dd](https://github.com/nperez0111/teleportal/commit/69309dd))
- Add which files should be distributed ([a25ad72](https://github.com/nperez0111/teleportal/commit/a25ad72))
- Make example location agnostic ([a5f4f09](https://github.com/nperez0111/teleportal/commit/a5f4f09))
- Add some more todos ([d355271](https://github.com/nperez0111/teleportal/commit/d355271))
- Update todos ([1959c1d](https://github.com/nperez0111/teleportal/commit/1959c1d))
- Rm package-lock ([f1cca6c](https://github.com/nperez0111/teleportal/commit/f1cca6c))
- Rm file ([00a5678](https://github.com/nperez0111/teleportal/commit/00a5678))
- Rename ([e7e9d25](https://github.com/nperez0111/teleportal/commit/e7e9d25))
- Make tests faster ([3375806](https://github.com/nperez0111/teleportal/commit/3375806))
- A little further ([f190812](https://github.com/nperez0111/teleportal/commit/f190812))
- Cleanup ([02cb154](https://github.com/nperez0111/teleportal/commit/02cb154))
- Update deps ([05b1dfa](https://github.com/nperez0111/teleportal/commit/05b1dfa))
- Add rules ([67a689a](https://github.com/nperez0111/teleportal/commit/67a689a))
- Bump deps ([0ca4593](https://github.com/nperez0111/teleportal/commit/0ca4593))
- Use bun serve in dev ([b836c5c](https://github.com/nperez0111/teleportal/commit/b836c5c))
- Rm unused deps ([436e08b](https://github.com/nperez0111/teleportal/commit/436e08b))
- Use gif ([76e244e](https://github.com/nperez0111/teleportal/commit/76e244e))
- Add docs for parts of the framework ([113b710](https://github.com/nperez0111/teleportal/commit/113b710))
- Rm done tasks ([07f95fa](https://github.com/nperez0111/teleportal/commit/07f95fa))
- Add TODO for guides ([dddd986](https://github.com/nperez0111/teleportal/commit/dddd986))
- Commit plans ([14684bc](https://github.com/nperez0111/teleportal/commit/14684bc))
- Update docs README ([e75e76b](https://github.com/nperez0111/teleportal/commit/e75e76b))
- Fix build ([389886f](https://github.com/nperez0111/teleportal/commit/389886f))
- Deploy docs separately ([feb0220](https://github.com/nperez0111/teleportal/commit/feb0220))
- Rm old endpoint ([1e1b5e7](https://github.com/nperez0111/teleportal/commit/1e1b5e7))

### ✅ Tests

- Update tests ([1136956](https://github.com/nperez0111/teleportal/commit/1136956))
- Add tests for the connection manager to be even more robust ([a7dfb9e](https://github.com/nperez0111/teleportal/commit/a7dfb9e))
- Fix tests ([05cf708](https://github.com/nperez0111/teleportal/commit/05cf708))
- Update tests ([fbac5c9](https://github.com/nperez0111/teleportal/commit/fbac5c9))
- Add tests for the server implementation ([#16](https://github.com/nperez0111/teleportal/pull/16))
- Fix race condition ([4370872](https://github.com/nperez0111/teleportal/commit/4370872))

### 🎨 Styles

- Cleanup ([3930c5e](https://github.com/nperez0111/teleportal/commit/3930c5e))
- Minor updates to layout & css ([33a2c9c](https://github.com/nperez0111/teleportal/commit/33a2c9c))

### ❤️ Contributors

- Nick The Sick ([@nperez0111](https://github.com/nperez0111))
- Nick Perez ([@nperez0111](https://github.com/nperez0111))
