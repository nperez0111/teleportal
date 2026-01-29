# Scaling Teleportal: Storage, Security, and Observability (5 Minutes)

---

## 0. Why This Matters

- Local-first apps still need production-grade servers
- Teleportal focuses on scalable, observable, secure sync

---

## 1. Storage: Interfaces, Not Implementations

- Separate storage interfaces:
  - DocumentStorage (Y.js updates + metadata)
  - FileStorage (chunked + Merkle)
  - MilestoneStorage (snapshots)
  - TemporaryUploadStorage (uploads)
- Mix backends freely: Postgres for docs, S3 for files, Redis for milestones
- Unstorage gives Redis/Postgres/S3/R2/etc. out of the box

---

## 2. Zero In-Memory Docs + VirtualStorage

- Server never holds full Y.Doc in memory
- Session loads on demand, cleans up after idle timeout
- **VirtualStorage** batches writes for high-frequency updates
- Keeps compute and storage decoupled for scaling

---

## 3. Multi-Node with PubSub

- Use Redis or NATS for cross-node fanout
- Server `nodeId` prevents echoing its own messages
- Scale horizontally without sacrificing CRDT convergence

```
Client -> Node A -> PubSub -> Node B -> Client
```

---

## 4. Security Model

- Per-message permission checks (read/write)
- JWT token utilities with document pattern matching, room scoping
- Auth messages signal allow/deny with reasons
- Encryption:
  - E2EE (AES-GCM for updates)
  - Encryption at rest supported in storage

---

## 5. Rate Limiting + Backpressure

- Token-bucket rate limiting at transport level
- Track by user / document / user-document / transport
- Max message size enforcement
- Streams API supports backpressure end-to-end

---

## 6. Observability & Ops

- Prometheus metrics (messages, storage ops, sizes, errors)
- Health + status endpoints for live diagnostics
- Document size warnings + limits for runaway docs

---

## 7. Devtools for Local-First Debugging

- Real-time message inspector (sent/received, ACKs)
- Filter by document, message type, direction
- Connection state + throughput stats
- Works with provider events, easy UI embed

---

## 8. Takeaway

- Teleportal scales without locking you into a stack
- Security is message-level, not just connection-level
- Observability is built in, not an afterthought
