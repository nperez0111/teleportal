# Teleportal Protocol Deep Dive (5 Minutes)

---

## 0. What This Covers

- Binary protocol structure and core message types
- Sync + awareness + ACK + file + milestone flows
- Why it matters for local-first CRDT systems

---

## 1. Protocol Goals

- Efficient binary messages for Y.js updates
- Streaming-friendly, batched transmission
- Supports doc sync, awareness, files, milestones, and auth
- Optional encryption flag at the message level

---

## 2. Message Envelope

```
Magic "YJS" | Version | DocNameLen | DocName | EncryptedFlag | MsgType | Payload
```

- Magic number validation + protocol version checking
- Document name can be empty for file messages
- ACK messages have no document name

---

## 3. Document Sync: Y.js Friendly

- **sync-step-1**: client sends state vector
- **sync-step-2**: server sends missing updates
- **update**: incremental updates from any client
- **sync-done**: explicit end of initial sync

```
Client -> sync-step-1 -> Server
Server -> sync-step-2 -> Client
Client <-> update <-> Server
Client <-> sync-done <-> Server
```

---

## 4. Awareness Messages

- Separate message category for presence / cursors
- **awareness-update**: broadcast presence
- **awareness-request**: ask for current state
- Can be filtered or handled independently from doc updates

---

## 5. ACK + Message Arrays

- ACK payload = base64 SHA-256 of encoded message bytes
- Useful for reliable delivery and file chunk tracking
- Message arrays allow batching:

```
len + msg1 | len + msg2 | ... (until buffer end)
```

---

## 6. File Transfer (Chunked + Merkle)

- 64KB chunks with Merkle proofs
- Upload uses temporary UUID -> final content ID (Merkle root)
- Integrity checked per chunk, dedup by content ID

```
Upload: file-upload -> file-part* -> (ACKs)
Download: file-download -> file-part* (verified)
```

---

## 7. Milestones (Snapshots + RPC)

- Document snapshots as first-class messages
- List / fetch snapshot / create / rename / delete / restore
- Supports lazy loading of snapshot data
- `createdBy` metadata tracks user vs system milestones

---

## 8. Error Handling + Security Hooks

- Invalid magic/version/type => decode error
- Auth messages for denied operations
- Encrypted flag for E2EE flows
- Permission checks can be applied per message at the server

---

## 9. Takeaway

- Protocol is explicit, verifiable, and stream-friendly
- Matches Y.js sync model while adding files + milestones + ACKs
- Good fit for local-first CRDT systems that need reliability
