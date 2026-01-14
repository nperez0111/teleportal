# Protocol

The Teleportal protocol is a binary messaging protocol built on top of Y.js for real-time collaborative document synchronization and awareness updates.

## Protocol Overview

The Teleportal protocol is designed for efficient transmission of Y.js collaborative editing messages over various transport layers. It supports both document synchronization and awareness updates with optional encryption.

## Message Format

### Base Message Structure

All Teleportal messages follow this base structure:

```
┌─────────────────────────────────────────────────────────────────┐
│                    Teleportal Message Header                    │
├─────────────┬─────────────┬─────────────┬───────────────────────┤
│ Magic Number│   Version   │ Doc Name Len│ Doc Name              │
│   (3 bytes) │  (1 byte)   │  (varint)   │  (string)             │
├─────────────┼─────────────┼─────────────┼───────────────────────┤
│ 0x59|0x4A|  │    0x01     │   length    │   UTF-8 string        │
│     0x53    │             │             │                        │
│    "YJS"    │             │             │                        │
└─────────────┴─────────────┴─────────────┴───────────────────────┘
```

### Message Type Identification

After the header, a single byte indicates the message category:

- `0x00` = Document Message
- `0x01` = Awareness Message
- `0x02` = ACK Message
- `0x03` = File Message

## Document Messages

Document messages handle Y.js document synchronization and updates.

### Document Message Types

#### Sync Step 1 (0x00)
Initiates synchronization by sending local state vector.

#### Sync Step 2 (0x01)
Responds to Sync Step 1 with missing updates.

#### Document Update (0x02)
Sends incremental document changes.

#### Sync Done (0x03)
Indicates synchronization completion.

#### Auth Message (0x04)
Handles authentication and authorization.

#### Milestone Messages (0x05-0x0D)
Handle milestone operations (list, create, update, snapshot).

## Awareness Messages

Awareness messages handle user presence and cursor information.

### Awareness Message Types

#### Awareness Update (0x00)
Sends user presence and cursor information.

#### Awareness Request (0x01)
Requests current awareness state.

## File Messages

File messages handle file uploads and downloads with chunking and Merkle tree verification.

### File Message Types

#### File Download (0x00)
Initiates file download by requesting a file using its content ID.

#### File Upload (0x01)
Initiates file upload by sending file metadata.

#### File Part (0x02)
Sends file chunk data with Merkle proof for verification.

#### File Auth Message (0x03)
Server response indicating permission denied or authorization status.

## Message Flow

### Document Synchronization

```
Client                           Server
  │                                │
  │─────── Sync Step 1 ──────────▶│  (with state vector)
  │                                │
  │◀────── Sync Step 2 ───────────│  (with missing updates)
  │                                │
  │─────── Sync Done ────────────▶│
  │                                │
  │◀────── Sync Done ─────────────│
  │                                │
  │─────── Doc Update ───────────▶│  (real-time changes)
  │                                │
  │◀────── Doc Update ────────────│  (propagated to other clients)
```

### File Upload

```
Client                           Server
  │                                │
  │─────── File Upload ──────────▶│  (metadata)
  │                                │
  │─────── File Part ────────────▶│  (chunk 0 + merkle proof)
  │                                │
  │─────── File Part ────────────▶│  (chunk 1 + merkle proof)
  │                                │
  │         ... (more chunks)      │
  │                                │
  │◀────── File Auth Message ─────│  (returns contentId)
```

## Encoding Details

### Variable-Length Integers (varint)

- Used for lengths and counts
- Follows lib0 encoding standard
- Efficient for small values, expandable for large ones

### Variable-Length Byte Arrays

- Length-prefixed byte arrays
- Length encoded as varint, followed by raw bytes
- Used for Y.js updates, state vectors, and string data

### String Encoding

- UTF-8 encoded strings
- Length-prefixed with varint length
- Used for document names and reason strings

## Special Messages

### Ping/Pong

Keep-alive messages for connection health monitoring:

```
Magic Number (3 bytes) + "ping" (4 bytes)
Magic Number (3 bytes) + "pong" (4 bytes)
```

### Message Arrays

Multiple messages can be batched into a single transmission:

```
Count (varint) + [Message 1 Length + Message 1 Data + ...]
```

## Usage Examples

### Encoding a Document Update

```typescript
import { DocMessage } from "teleportal/protocol";

const docMessage = new DocMessage("my-document", {
  type: "update",
  update: yDocUpdate
});
const encoded = docMessage.encoded;
```

### Decoding a Message

```typescript
import { decodeMessage } from "teleportal/protocol";

const decoded = decodeMessage(receivedBytes);
if (decoded.type === "doc") {
  console.log(`Document: ${decoded.document}`);
  console.log(`Update type: ${decoded.payload.type}`);
}
```

### Creating Awareness Update

```typescript
import { AwarenessMessage } from "teleportal/protocol";

const awarenessMessage = new AwarenessMessage("my-document", {
  type: "awareness-update",
  update: awarenessUpdate
});
```

## Security Considerations

- **Magic Number Validation**: Ensures message is valid Teleportal format
- **Version Checking**: Verifies protocol version compatibility
- **Type Validation**: Validates message and payload types
- **Length Validation**: Ensures proper message boundaries
- **Encryption Flag**: Built-in support for encrypted payloads

## Next Steps

- [Encryption](./encryption.md) - Learn about encrypted messages
- [File Transfer](./file-transfer.md) - Learn about file transfer protocol
- [API Reference](../api/protocol.md) - Complete protocol API documentation
