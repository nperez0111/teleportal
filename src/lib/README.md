# Teleportal Protocol Documentation

This directory contains the implementation of the Teleportal protocol, a binary messaging protocol built on top of Y.js for real-time collaborative document synchronization and awareness updates.

## Protocol Overview

The Teleportal protocol is designed for efficient transmission of Y.js collaborative editing messages over various transport layers. It supports both document synchronization and awareness updates with optional encryption.

## Message Format

### Base Message Structure

All Teleportal messages follow this base structure:

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                            Teleportal Message Header                            │
├─────────────┬─────────────┬─────────────┬─────────────┬─────────────────────────┤
│ Magic Number│   Version   │ Doc Name Len│ Doc Name    │      Encrypted Flag     │
│   (3 bytes) │  (1 byte)   │  (varint)   │  (string)   │       (1 byte)          │
├─────────────┼─────────────┼─────────────┼─────────────┼─────────────────────────┤
│ 0x59|0x4A|  │    0x01     │   length    │   UTF-8     │    0x00=false           │
│     0x53    │             │             │   string    │    0x01=true            │
│    "YJS"    │             │             │             │                         │
└─────────────┴─────────────┴─────────────┴─────────────┴─────────────────────────┘
```

### Message Type Identification

After the header, a single byte indicates the message category:

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                            Message Type Byte                                    │
├─────────────────────────────────────────────────────────────────────────────────┤
│ 0x00 = Document Message                                                         │
│ 0x01 = Awareness Message                                                        │
│ 0x02 = ACK Message                                                              │
│ 0x03 = File Message                                                             │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## Document Messages (Type 0x00)

Document messages handle Y.js document synchronization and updates. They include several subtypes:

### Document Message Structure

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                        Document Message Format                                │
├─────────────┬─────────────────────────────────────────────────────────────────┤
│ Msg Type    │                    Payload                                      │
│ (1 byte)    │                  (variable)                                     │
├─────────────┼─────────────────────────────────────────────────────────────────┤
│ 0x00 = Sync │ State Vector (varint array)                                     │
│ Step 1      │                                                                 │
├─────────────┼─────────────────────────────────────────────────────────────────┤
│ 0x01 = Sync │ Y.js Update (varint array)                                      │
│ Step 2      │                                                                 │
├─────────────┼─────────────────────────────────────────────────────────────────┤
│ 0x02 = Doc  │ Y.js Update (varint array)                                      │
│ Update      │                                                                 │
├─────────────┼─────────────────────────────────────────────────────────────────┤
│ 0x03 = Sync │ (no payload)                                                    │
│ Done        │                                                                 │
├─────────────┼─────────────────────────────────────────────────────────────────┤
│ 0x04 = Auth │ Permission (1 byte) + Reason (varint string)                    │
│ Message     │ 0x00=denied, 0x01=allowed                                       │
└─────────────┴─────────────────────────────────────────────────────────────────┘
```

### Document Message Types

#### 1. Sync Step 1 (0x00)

**Purpose**: Initiates synchronization by sending local state vector
**Payload**: Y.js state vector as variable-length byte array
**Usage**: Client sends this to request updates from server

#### 2. Sync Step 2 (0x01)

**Purpose**: Responds to Sync Step 1 with missing updates
**Payload**: Y.js update containing missing operations
**Usage**: Server responds with updates not present in client's state

#### 3. Document Update (0x02)

**Purpose**: Sends incremental document changes
**Payload**: Y.js update containing new operations
**Usage**: Real-time propagation of document changes

#### 4. Sync Done (0x03)

**Purpose**: Indicates synchronization completion
**Payload**: None
**Usage**: Signals that both sync steps have been completed

#### 5. Auth Message (0x04)

**Purpose**: Handles authentication and authorization
**Payload**: Permission flag (1 byte) + reason string (variable length)
**Usage**: Server sends to grant/deny access with explanation

## Awareness Messages (Type 0x01)

Awareness messages handle user presence and cursor information in collaborative sessions.

### Awareness Message Structure

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                       Awareness Message Format                                  │
├─────────────┬───────────────────────────────────────────────────────────────────┤
│ Msg Type    │                    Payload                                        │
│ (1 byte)    │                  (variable)                                       │
├─────────────┼───────────────────────────────────────────────────────────────────┤
│ 0x00 = Aware│ Y.js Awareness Update (varint array)                              │
│ Update      │                                                                   │
├─────────────┼───────────────────────────────────────────────────────────────────┤
│ 0x01 = Aware│ (no payload)                                                      │
│ Request     │                                                                   │
└─────────────┴───────────────────────────────────────────────────────────────────┘
```

### Awareness Message Types

#### 1. Awareness Update (0x00)

**Purpose**: Sends user presence and cursor information
**Payload**: Y.js awareness update as variable-length byte array
**Usage**: Propagates user activity, cursor position, selection state

#### 2. Awareness Request (0x01)

**Purpose**: Requests current awareness state
**Payload**: None
**Usage**: Client requests current user presence information

## File Messages (Type 0x03)

File messages handle file uploads and downloads with chunking and Merkle tree verification for integrity.

### File Message Structure

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                            File Message Format                                  │
├─────────────┬───────────────────────────────────────────────────────────────────┤
│ Msg Type    │                    Payload                                        │
│ (1 byte)    │                  (variable)                                       │
├─────────────┼───────────────────────────────────────────────────────────────────┤
│ 0x00 = File │ Direction (1 byte) + FileId (string) + Filename (string) +        │
│ Request     │ Size (varint) + MimeType (string)                                │
├─────────────┼───────────────────────────────────────────────────────────────────┤
│ 0x01 = File │ FileId (string) + ChunkIndex (varint) + ChunkData (varint array)  │
│ Progress    │ + MerkleProof (array) + TotalChunks (varint) +                    │
│             │ BytesUploaded (varint) + Encrypted (1 byte)                       │
├─────────────┼───────────────────────────────────────────────────────────────────┤
│ 0x02 = File │ Reason (string)                                                   │
│ Auth        │                                                                   │
└─────────────┴───────────────────────────────────────────────────────────────────┘
```

### File Message Types

#### 1. File Request (0x00)

**Purpose**: Initiates file upload or download

**Payload Structure**:

- Direction (1 byte): `0x00` = upload, `0x01` = download
- FileId (varint string):
  - For uploads: Client-generated UUID for this transfer
  - For downloads: Merkle root hash (hex string) identifying the file to download
- Filename (varint string): Original filename
- Size (varint): File size in bytes
- MimeType (varint string): MIME type of the file

**Usage**:

- **Upload**: Client sends file metadata with a client-generated UUID as fileId to initiate upload session. After upload completes, the client receives the merkle root hash (hex string) which should be used as the fileId for future downloads.
- **Download**: Client requests file by providing the merkle root hash (hex string) as the fileId

#### 2. File Progress (0x01)

**Purpose**: Sends file chunk data with Merkle proof for verification

**Payload Structure**:

- FileId (varint string): Client-generated UUID matching the file request
- ChunkIndex (varint): Zero-based index of this chunk
- ChunkData (varint array): Chunk data (typically 64KB)
- MerkleProofLength (varint): Number of proof hashes
- MerkleProof (array of varint arrays): Merkle proof path hashes
- TotalChunks (varint): Total number of chunks in the file
- BytesUploaded (varint): Cumulative bytes uploaded so far
- Encrypted (1 byte): `0x00` = false, `0x01` = true

**Usage**: Client sends chunks sequentially with Merkle proofs for server verification

#### 3. File Auth Message (0x02)

**Purpose**: Server response indicating permission denied

**Payload Structure**:

- Reason (varint string): Explanation for denial

**Usage**: Server sends when file request is rejected (e.g., size limit exceeded, unauthorized)

### File Chunking and Merkle Trees

Files are split into **64KB chunks** for efficient transfer. Each chunk is hashed using SHA-256, and a Merkle tree is constructed to verify file integrity.

#### Merkle Tree Structure

```
                    Root Hash (ContentId)
                         /        \
                    Hash 1        Hash 2
                    /    \        /    \
                Hash 3  Hash 4  Hash 5  Hash 6
                /   \   /   \   /   \   /   \
              Chunk Chunk Chunk Chunk Chunk Chunk Chunk Chunk
               0     1     2     3     4     5     6     7
```

- **Leaf nodes**: SHA-256 hash of each 64KB chunk
- **Internal nodes**: Hash of concatenated child hashes
- **Root hash**: Content ID used to uniquely identify the file
- **Merkle proof**: Path from chunk hash to root (sibling hashes at each level)

#### Chunk Verification

For each chunk, the client sends:

1. Chunk data (64KB)
2. Merkle proof (array of sibling hashes from leaf to root)
3. Chunk index

The server verifies by:

1. Hashing the chunk data
2. Reconstructing the path to root using the proof
3. Comparing the computed root hash with the expected contentId

## Special Message Types

### Ping/Pong Messages

Keep-alive messages for connection health monitoring:

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                          Ping Message                                         │
├─────────────┬─────────────┬─────────────┬─────────────┬───────────────────────┤
│ Magic Number│      "ping" ASCII bytes                                         │
│   (3 bytes) │           (4 bytes)                                             │
├─────────────┼─────────────┼─────────────┼─────────────┼───────────────────────┤
│ 0x59|0x4A|  │ 0x70|0x69|  │                                                   │
│     0x53    │ 0x6E|0x67   │                                                   │
│    "YJS"    │   "ping"    │                                                   │
└─────────────┴─────────────┴─────────────┴─────────────┴───────────────────────┘
```

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                          Pong Message                                         │
├─────────────┬─────────────┬─────────────┬─────────────┬───────────────────────┤
│ Magic Number│      "pong" ASCII bytes                                         │
│   (3 bytes) │           (4 bytes)                                             │
├─────────────┼─────────────┼─────────────┼─────────────┼───────────────────────┤
│ 0x59|0x4A|  │ 0x70|0x6F|  │                                                   │
│     0x53    │ 0x6E|0x67   │                                                   │
│    "YJS"    │   "pong"    │                                                   │
└─────────────┴─────────────┴─────────────┴─────────────┴───────────────────────┘
```

### Message Arrays

Multiple messages can be batched into a single transmission:

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                        Message Array Format                                   │
├─────────────┬─────────────────────────────────────────────────────────────────┤
│ Count       │                Messages                                         │
│ (varint)    │              (variable)                                         │
├─────────────┼─────────────────────────────────────────────────────────────────┤
│ Number of   │ Message 1 Length (varint) + Message 1 Data +                    │
│ messages    │ Message 2 Length (varint) + Message 2 Data +                    │
│             │ ... (repeated for all messages)                                 │
└─────────────┴─────────────────────────────────────────────────────────────────┘
```

## Encoding Details

### Variable-Length Integers (varint)

- Used for lengths and counts
- Follows lib0 encoding standard
- Efficient for small values, expandable for large ones

### Variable-Length Byte Arrays (varint array)

- Length-prefixed byte arrays
- Length encoded as varint, followed by raw bytes
- Used for Y.js updates, state vectors, and string data

### String Encoding

- UTF-8 encoded strings
- Length-prefixed with varint length
- Used for document names and reason strings

## Message Flow Examples

### Document Synchronization Flow

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

### Awareness Flow

```
Client                           Server
  │                                │
  │◀───── Awareness Request ──────│  (request current user states)
  │                                │
  │─────── Awareness Update ─────▶│  (user cursor/selection)
  │                                │
  │◀────── Awareness Update ──────│  (other clients' user states)
```

### File Upload Flow

```
Client                           Server
  │                                │
  │─────── File Request ─────────▶│  (upload, metadata)
  │      (direction: upload)       │
  │                                │
  │                                │  (creates upload session)
  │                                │
  │─────── File Progress ────────▶│  (chunk 0 + merkle proof)
  │                                │
  │                                │  (verifies chunk, stores)
  │                                │
  │─────── File Progress ────────▶│  (chunk 1 + merkle proof)
  │                                │
  │                                │  (verifies chunk, stores)
  │                                │
  │         ... (more chunks)      │
  │                                │
  │─────── File Progress ────────▶│  (final chunk + merkle proof)
  │                                │
  │                                │  (verifies all chunks,
  │                                │   reconstructs merkle tree,
  │                                │   stores file, removes session)
```

### File Download Flow

```
Client                           Server
  │                                │
  │─────── File Request ─────────▶│  (download, contentId)
  │     (direction: download)      │
  │                                │
  │                                │  (looks up file by contentId)
  │                                │
  │◀────── File Progress ─────────│  (chunk 0 + merkle proof)
  │                                │
  │                                │  (client verifies chunk)
  │                                │
  │◀────── File Progress ─────────│  (chunk 1 + merkle proof)
  │                                │
  │                                │  (client verifies chunk)
  │                                │
  │         ... (more chunks)      │
  │                                │
  │◀────── File Progress ─────────│  (final chunk + merkle proof)
  │                                │
  │                                │  (client verifies all chunks,
  │                                │   reconstructs file)
```

## Error Handling

The protocol includes robust error handling:

- **Magic Number Validation**: Ensures message is valid Teleportal format
- **Version Checking**: Verifies protocol version compatibility
- **Type Validation**: Validates message and payload types
- **Length Validation**: Ensures proper message boundaries

## Security Considerations

- **Encryption Flag**: Built-in support for encrypted payloads
- **Authentication**: Auth messages provide access control
- **Validation**: All inputs are validated before processing

## Usage Examples

```typescript
// Encoding a document update
const docMessage = new DocMessage("my-document", {
  type: "update",
  update: yDocUpdate
});
const encoded = docMessage.encoded;

// Decoding a received message
const decoded = decodeMessage(receivedBytes);
if (decoded.type === "doc") {
  // Handle document message
  console.log(`Document: ${decoded.document}`);
  console.log(`Update type: ${decoded.payload.type}`);
}

// Creating awareness update
const awarenessMessage = new AwarenessMessage("my-document", {
  type: "awareness-update",
  update: awarenessUpdate
});

// Initiating file upload
const fileRequest = new FileMessage({
  type: "file-request",
  direction: "upload",
  fileId: "unique-file-id",
  filename: "document.pdf",
  size: 1024000,
  mimeType: "application/pdf"
});

// Sending file chunk with Merkle proof
const fileProgress = new FileMessage({
  type: "file-progress",
  fileId: "unique-file-id",
  chunkIndex: 0,
  chunkData: chunkBytes,
  merkleProof: [hash1, hash2, hash3], // Path to root
  totalChunks: 16,
  bytesUploaded: 65536,
  encrypted: false
});

// Requesting file download
const downloadRequest = new FileMessage({
  type: "file-request",
  direction: "download",
  fileId: "download-session-id",
  filename: "", // Not required for downloads
  size: 0, // Not required for downloads
  mimeType: "", // Not required for downloads
  contentId: merkleRootHash // Required: identifies the file
});
```

## File Transfer Details

### Chunk Size

Files are split into **64KB (65,536 bytes) chunks** for efficient transfer. This size balances:

- Network efficiency (larger chunks reduce overhead)
- Memory usage (smaller chunks reduce memory pressure)
- Error recovery (smaller chunks enable partial retry)

### Maximum File Size

The protocol supports files up to **1GB (1,073,741,824 bytes)**. Files exceeding this limit are rejected with a file auth message.

### Content-Addressable Storage

Files are stored using their **Merkle root hash (contentId)** as the identifier. This provides:

- **Deduplication**: Identical files share the same contentId
- **Integrity**: ContentId changes if any chunk is modified
- **Verification**: Clients can verify file integrity using Merkle proofs

### Encryption Support

Files can be encrypted before chunking. The encrypted flag in file progress messages indicates whether the chunk data is encrypted. Encryption is handled at the application layer before protocol encoding.

This protocol ensures efficient, type-safe communication for collaborative editing applications while maintaining compatibility with the Y.js ecosystem and providing robust file transfer capabilities with integrity verification.
