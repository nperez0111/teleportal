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

**Note**: For file messages, the document name may be an empty string. ACK messages do not have a document name (it is `undefined`).

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
├─────────────┼─────────────────────────────────────────────────────────────────┤
│ 0x05 = Mile │ SnapshotIds count (varint) + SnapshotIds array (varint strings) │
│ List Req    │                                                                 │
├─────────────┼─────────────────────────────────────────────────────────────────┤
│ 0x06 = Mile │ Count (varint) + [Id + Name + DocId + CreatedAt + DeletedAt? + │
│ List Resp   │ LifecycleState? + ExpiresAt? + CreatedBy] * N                   │
├─────────────┼─────────────────────────────────────────────────────────────────┤
│ 0x07 = Mile │ MilestoneId (varint string)                                     │
│ Snapshot Req│                                                                 │
├─────────────┼─────────────────────────────────────────────────────────────────┤
│ 0x08 = Mile │ MilestoneId (varint string) + Snapshot (varint array)           │
│ Snapshot Res│                                                                 │
├─────────────┼─────────────────────────────────────────────────────────────────┤
│ 0x09 = Mile │ HasName (1 byte) + Name (varint string, optional) +             │
│ Create Req  │ Snapshot (varint array)                                         │
├─────────────┼─────────────────────────────────────────────────────────────────┤
│ 0x0A = Mile │ Id + Name + DocId + CreatedAt + CreatedBy (Type + Id)          │
│ Create Resp │                                                                 │
├─────────────┼─────────────────────────────────────────────────────────────────┤
│ 0x0B = Mile │ MilestoneId (varint string) + Name (varint string)              │
│ Update Name │                                                                 │
├─────────────┼─────────────────────────────────────────────────────────────────┤
│ 0x0C = Mile │ Id + Name + DocId + CreatedAt + CreatedBy (Type + Id)           │
│ Update Resp │                                                                 │
├─────────────┼─────────────────────────────────────────────────────────────────┤
│ 0x0D = Mile │ Permission (1 byte) + Reason (varint string)                    │
│ Auth Msg    │ 0x00=denied, 0x01=allowed                                       │
├─────────────┼─────────────────────────────────────────────────────────────────┤
│ 0x0E = Mile │ MilestoneId (varint string)                                     │
│ SoftDel Req │                                                                 │
├─────────────┼─────────────────────────────────────────────────────────────────┤
│ 0x0F = Mile │ MilestoneId (varint string)                                     │
│ SoftDel Resp│                                                                 │
├─────────────┼─────────────────────────────────────────────────────────────────┤
│ 0x10 = Mile │ MilestoneId (varint string)                                     │
│ Restore Req │                                                                 │
├─────────────┼─────────────────────────────────────────────────────────────────┤
│ 0x11 = Mile │ MilestoneId (varint string)                                     │
│ Restore Resp│                                                                 │
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

#### 6. Milestone List Request (0x05)

**Purpose**: Requests a list of all milestones for a document
**Payload**: SnapshotIds count (varint) + SnapshotIds array (varint strings)
**Usage**: Client requests milestone metadata (without snapshot content). The client can provide a list of snapshot IDs so the server can send only milestones that are not already known.

#### 7. Milestone List Response (0x06)

**Purpose**: Returns list of milestone metadata
**Payload**: Count (varint) + array of milestone metadata (id, name, documentId, createdAt, deletedAt (optional), lifecycleState (optional), expiresAt (optional), createdBy (required))
**Usage**: Server responds with milestone list. Each milestone includes:

- Required fields: id, name, documentId, createdAt, createdBy
- Optional fields: deletedAt, lifecycleState, expiresAt
- `createdBy`: Indicates who/what created the milestone (`{ type: "user" | "system", id: string }`)

#### 8. Milestone Snapshot Request (0x07)

**Purpose**: Requests the snapshot content for a specific milestone
**Payload**: MilestoneId (varint string)
**Usage**: Client requests full snapshot data to fulfill lazy loading

#### 9. Milestone Snapshot Response (0x08)

**Purpose**: Returns the snapshot content for a milestone
**Payload**: MilestoneId (varint string) + Snapshot (varint array - binary encoded)
**Usage**: Server responds with milestone snapshot data

#### 10. Milestone Create Request (0x09)

**Purpose**: Requests creation of a new milestone from current document state
**Payload**: HasName (1 byte) + Name (varint string, optional) + Snapshot (varint array)
**Usage**: Client requests milestone creation with the document snapshot; server auto-generates name if not provided

#### 11. Milestone Create Response (0x0A)

**Purpose**: Confirms milestone creation and returns metadata
**Payload**: Milestone metadata (id, name, documentId, createdAt, createdBy)
**Usage**: Server responds with created milestone information. The `createdBy` field indicates who created the milestone:

- `{ type: "user", id: userId }` for user-created milestones
- `{ type: "system", id: nodeId }` for system-created milestones

#### 12. Milestone Update Name Request (0x0B)

**Purpose**: Requests updating a milestone's name
**Payload**: MilestoneId (varint string) + Name (varint string)
**Usage**: Client requests name change for an existing milestone

#### 13. Milestone Update Name Response (0x0C)

**Purpose**: Confirms milestone name update
**Payload**: Milestone metadata (id, name, documentId, createdAt, createdBy)
**Usage**: Server responds with updated milestone information. When a user renames a milestone, the `createdBy` field is updated to mark it as user-created (`{ type: "user", id: userId }`).

#### 14. Milestone Auth Message (0x0D)

**Purpose**: Error response for milestone operations
**Payload**: Permission flag (1 byte) + reason string (variable length)
**Usage**: Server sends when milestone operation fails (not found, permission denied, etc.)

#### 15. Milestone Soft Delete Request (0x0E)

**Purpose**: Requests soft deletion of a milestone
**Payload**: MilestoneId (varint string)
**Usage**: Client requests soft deletion of a milestone

#### 16. Milestone Soft Delete Response (0x0F)

**Purpose**: Confirms soft deletion of a milestone
**Payload**: MilestoneId (varint string)
**Usage**: Server responds with ID of the soft deleted milestone

#### 17. Milestone Restore Request (0x10)

**Purpose**: Requests restoration of a soft-deleted milestone
**Payload**: MilestoneId (varint string)
**Usage**: Client requests restoration of a deleted milestone

#### 18. Milestone Restore Response (0x11)

**Purpose**: Confirms restoration of a milestone
**Payload**: MilestoneId (varint string)
**Usage**: Server responds with ID of the restored milestone

## ACK Messages (Type 0x02)

ACK messages provide message delivery confirmation, allowing senders to know when their messages have been successfully received and processed.

### ACK Message Structure

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                            ACK Message Format                                   │
├─────────────┬───────────────────────────────────────────────────────────────────┤
│ Msg Type    │                    Payload                                        │
│ (1 byte)    │                  (variable)                                       │
├─────────────┼───────────────────────────────────────────────────────────────────┤
│ 0x02 = ACK  │ MessageId (varint array) - Base64-decoded message ID              │
└─────────────┴───────────────────────────────────────────────────────────────────┘
```

### ACK Message Details

**Purpose**: Acknowledges receipt of a specific message
**Payload**: MessageId (varint array) - The base64-decoded message ID of the message being acknowledged
**Usage**:

- Used to confirm delivery of file chunks during uploads
- Allows senders to track which messages have been successfully received
- The messageId is the SHA-256 hash (base64-encoded) of the original message's encoded bytes

**Note**: ACK messages do not have a document name and are not tied to a specific document context.

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
┌───────────────────────────────────────────────────────────────────────────────────┐
│                            File Message Format                                    │
├─────────────┬─────────────────────────────────────────────────────────────────────┤
│ Msg Type    │                    Payload                                          │
│ (1 byte)    │                  (variable)                                         │
├─────────────┼─────────────────────────────────────────────────────────────────────┤
│ 0x00 = File │ FileId (varint string)                                              │
│ Download    │                                                                     │
├─────────────┼─────────────────────────────────────────────────────────────────────┤
│ 0x01 = File │ Encrypted (1 byte) + FileId (varint string) + Filename (string)     │
│ Upload      │ + Size (varint) + MimeType (string) + LastModified (varint)         │
├─────────────┼─────────────────────────────────────────────────────────────────────┤
│ 0x02 = File │ FileId (varint string) + ChunkIndex (varint) + ChunkData            │
│ Part        │ (varint array) + MerkleProofLength (varint) + MerkleProof (array) + │
│             │ TotalChunks (varint) + BytesUploaded (varint) + Encrypted (1 byte)  │
├─────────────┼─────────────────────────────────────────────────────────────────────┤
│ 0x03 = File │ Permission (1 byte) + FileId (varint string) + StatusCode           │
│ Auth        │ (varint) + HasReason (1 byte) + Reason (varint string, optional)    │
│ Message     │                                                                     │
└─────────────┴─────────────────────────────────────────────────────────────────────┘
```

### File Message Types

#### 1. File Download (0x00)

**Purpose**: Initiates file download by requesting a file using its content ID

**Payload Structure**:

- FileId (varint string): Merkle root hash (base64 string) identifying the file to download

**Usage**: Client requests file by providing the merkle root hash as the fileId. The server responds with file-part messages containing the file chunks.

#### 2. File Upload (0x01)

**Purpose**: Initiates file upload by sending file metadata

**Payload Structure**:

- Encrypted (1 byte): `0x00` = false, `0x01` = true
- FileId (varint string): Client-generated UUID for this transfer session
- Filename (varint string): Original filename
- Size (varint): File size in bytes (includes encryption overhead if encrypted)
- MimeType (varint string): MIME type of the file
- LastModified (varint): Last modified timestamp of the file

**Usage**:

- Client sends file metadata with a client-generated UUID as `fileId` to initiate upload session
- During upload, chunks are sent with this same `fileId` (UUID) to identify the transfer session
- After all chunks are uploaded and verified, the server computes the Merkle root hash
- The client receives this Merkle root hash (base64-encoded) as the final `fileId`, which should be used for future downloads
- **Note**: The `fileId` changes from the temporary UUID to the permanent Merkle root hash after upload completion

#### 3. File Part (0x02)

**Purpose**: Sends file chunk data with Merkle proof for verification

**Payload Structure**:

- FileId (varint string):
  - **Upload**: Client-generated UUID matching the file upload session
  - **Download**: Merkle root hash (base64 string) identifying the file
- ChunkIndex (varint): Zero-based index of this chunk
- ChunkData (varint array): Chunk data (typically 64KB, or smaller for encrypted chunks)
- MerkleProofLength (varint): Number of proof hashes in the Merkle proof path
- MerkleProof (array of varint arrays): Merkle proof path hashes (sibling hashes from leaf to root)
- TotalChunks (varint): Total number of chunks in the file
- BytesUploaded (varint): Cumulative bytes uploaded/downloaded so far
- Encrypted (1 byte): `0x00` = false, `0x01` = true

**Usage**:

- **Upload**: Client sends chunks sequentially with Merkle proofs for server verification. Each chunk is acknowledged with an ACK message containing the chunk's message ID.
- **Download**: Server sends chunks sequentially with Merkle proofs for client verification. The client verifies each chunk before assembling the complete file.

**Chunk Verification**: The receiver verifies each chunk by:

1. Computing the SHA-256 hash of the chunk data
2. Reconstructing the Merkle tree path using the provided proof hashes
3. Comparing the computed root hash with the expected fileId
4. Rejecting the chunk if verification fails

#### 4. File Auth Message (0x03)

**Purpose**: Server response indicating permission denied or authorization status

**Payload Structure**:

- Permission (1 byte): `0x00` = denied, `0x01` = allowed (currently only denied is supported)
- FileId (varint string): The fileId of the file that was denied authorization
- StatusCode (varint): HTTP status code (404, 403, 401, 500, or 501)
- HasReason (1 byte): `0x00` = no reason, `0x01` = reason follows
- Reason (varint string, optional): Explanation for denial (only present if HasReason is 1)

**Usage**: Server sends when file request is rejected (e.g., size limit exceeded, unauthorized, file not found)

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

Multiple messages can be batched into a single transmission for efficiency. Messages are concatenated sequentially without an explicit count field:

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                        Message Array Format                                   │
├───────────────────────────────────────────────────────────────────────────────┤
│ Message 1 Length (varint) + Message 1 Data (BinaryMessage) +                  │
│ Message 2 Length (varint) + Message 2 Data (BinaryMessage) +                  │
│ ... (repeated for all messages until end of buffer)                           │
└───────────────────────────────────────────────────────────────────────────────┘
```

**Encoding**: Each message in the array is encoded as a varint-prefixed byte array. The decoder reads messages sequentially until the buffer is exhausted.

**Usage**: Useful for reducing network overhead when sending multiple related messages (e.g., multiple document updates or file chunks).

## Encoding Details

### Message IDs

Every message has a unique identifier computed from its encoded bytes:

- **Computation**: SHA-256 hash of the message's encoded binary representation
- **Encoding**: Base64-encoded for use in ACK messages and other contexts
- **Purpose**: Enables message deduplication, acknowledgment tracking, and idempotency
- **Lazy Computation**: Message IDs are computed on-demand and cached for performance

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
  │─────── File Upload ──────────▶│  (metadata: uploadId, filename, size, etc.)
  │                                │
  │                                │  (creates upload session)
  │                                │
  │─────── File Part ────────────▶│  (chunk 0 + merkle proof)
  │                                │
  │                                │  (verifies chunk, stores)
  │                                │
  │─────── File Part ────────────▶│  (chunk 1 + merkle proof)
  │                                │
  │                                │  (verifies chunk, stores)
  │                                │
  │         ... (more chunks)      │
  │                                │
  │─────── File Part ────────────▶│  (final chunk + merkle proof)
  │                                │
  │                                │  (verifies all chunks,
  │                                │   reconstructs merkle tree,
  │                                │   stores file, removes session)
  │                                │
  │◀────── File Auth Message ─────│  (optional: returns contentId/fileId)
```

### File Download Flow

```
Client                           Server
  │                                │
  │─────── File Download ────────▶│  (fileId: merkle root hash)
  │                                │
  │                                │  (looks up file by fileId/contentId)
  │                                │
  │◀────── File Part ─────────────│  (chunk 0 + merkle proof)
  │                                │
  │                                │  (client verifies chunk)
  │                                │
  │◀────── File Part ─────────────│  (chunk 1 + merkle proof)
  │                                │
  │                                │  (client verifies chunk)
  │                                │
  │         ... (more chunks)      │
  │                                │
  │◀────── File Part ─────────────│  (final chunk + merkle proof)
  │                                │
  │                                │  (client verifies all chunks,
  │                                │   reconstructs file)
  │                                │
  │◀────── File Auth Message ─────│  (optional: error if file not found)
```

### Milestone Operations Flow

```
Client                           Server
  │                                │
  │─────── List Request ──────────▶│  (request milestone list)
  │                                │
  │◀────── List Response ──────────│  (returns milestone metadata)
  │                                │
  │─────── Snapshot Request ──────▶│  (request specific snapshot)
  │                                │
  │◀────── Snapshot Response ──────│  (returns snapshot data)
  │                                │
  │─────── Create Request ────────▶│  (create milestone with snapshot,
  │                                │   optional name)
  │                                │
  │                                │  (validates snapshot, stores milestone)
  │                                │
  │◀────── Create Response ───────│  (returns created milestone metadata)
  │                                │
  │─────── Update Name Request ──▶│  (update milestone name)
  │                                │
  │◀────── Update Name Response ──│  (returns updated milestone)
```

## Error Handling

The protocol includes robust error handling:

- **Magic Number Validation**: Ensures message is valid Teleportal format (must start with `0x59 0x4A 0x53` / "YJS")
- **Version Checking**: Verifies protocol version compatibility (currently only version `0x01` is supported)
- **Type Validation**: Validates message and payload types
- **Length Validation**: Ensures proper message boundaries using varint encoding
- **Decoding Errors**: Invalid messages throw descriptive errors with context about the failure
- **File Transfer Errors**: File operations can fail with auth messages containing status codes (401, 403, 404, 500, 501) and optional reason strings
- **Milestone Errors**: Milestone operations can fail with milestone auth messages containing denial reasons

## Security Considerations

- **Encryption Flag**: Built-in support for encrypted payloads
- **Authentication**: Auth messages provide access control
- **Validation**: All inputs are validated before processing

## Usage Examples

```typescript
// Encoding a document update
const docMessage = new DocMessage("my-document", {
  type: "update",
  update: yDocUpdate,
});
const encoded = docMessage.encoded;

// Decoding a received message
const decoded = decodeMessage(receivedBytes);
if (decoded.type === "doc") {
  // Handle document message
  console.log(`Document: ${decoded.document}`);
  console.log(`Update type: ${decoded.payload.type}`);
}

// Creating an ACK message
const ackMessage = new AckMessage({
  type: "ack",
  messageId: "base64-encoded-message-id",
});

// Batching multiple messages
import { encodeMessageArray, decodeMessageArray } from "./multi-message";
const messages = [docMessage, awarenessMessage];
const batched = encodeMessageArray(messages);
const decodedMessages = decodeMessageArray(batched);

// Creating awareness update
const awarenessMessage = new AwarenessMessage("my-document", {
  type: "awareness-update",
  update: awarenessUpdate,
});

// File operations now use the RPC system
// See teleportal/protocols/file for FileUploadRequest, FileDownloadRequest, and FilePartStream types
import { RpcMessage } from "teleportal/protocol";
import type { FilePartStream } from "teleportal/protocols/file";

// Initiating file upload via RPC
const fileUploadRequest = new RpcMessage(
  "my-document",
  {
    method: "fileUpload",
    fileId: "unique-upload-id",
    filename: "document.pdf",
    size: 1024000,
    mimeType: "application/pdf",
    lastModified: Date.now(),
    encrypted: false,
  },
  "request",
  undefined,
  {},
  false,
);

// Sending file chunk with Merkle proof as RPC stream
const filePart: FilePartStream = {
  fileId: "unique-upload-id",
  chunkIndex: 0,
  chunkData: chunkBytes,
  merkleProof: [hash1, hash2, hash3],
  totalChunks: 16,
  bytesUploaded: 65536,
  encrypted: false,
};
const filePartMessage = new RpcMessage(
  "my-document",
  { type: "stream", payload: filePart },
  "stream",
  originalRequestId, // Links to the original fileUpload request
  {},
  false,
);

// Requesting file download via RPC
const fileDownloadRequest = new RpcMessage(
  "my-document",
  {
    method: "fileDownload",
    fileId: merkleRootHash, // Merkle root hash (base64) identifying the file
  },
  "request",
  undefined,
  {},
  false,
);

// Requesting milestone list
const milestoneListRequest = new DocMessage("my-document", {
  type: "milestone-list-request",
  snapshotIds: ["known-id-1", "known-id-2"], // Optional: list of snapshot IDs already known to the client
});

// Requesting milestone snapshot
const milestoneSnapshotRequest = new DocMessage("my-document", {
  type: "milestone-snapshot-request",
  milestoneId: "milestone-id-123",
});

// Creating a milestone
const milestoneCreateRequest = new DocMessage("my-document", {
  type: "milestone-create-request",
  name: "v1.0.0", // Optional - server auto-generates if not provided
  snapshot: documentSnapshot, // Required: Y.js document snapshot
});

// Updating milestone name
const milestoneUpdateNameRequest = new DocMessage("my-document", {
  type: "milestone-update-name-request",
  milestoneId: "milestone-id-123",
  name: "v1.0.1",
});
```

## File Transfer Details

### Chunk Size

Files are split into **64KB (65,536 bytes) chunks** for efficient transfer. This size balances:

- Network efficiency (larger chunks reduce overhead)
- Memory usage (smaller chunks reduce memory pressure)
- Error recovery (smaller chunks enable partial retry)

### Maximum File Size

The protocol supports files up to **2^53 - 1 bytes** (approximately 9 petabytes) as defined by JavaScript's safe integer limit. Application-specific size limits may be enforced by the server, which will reject files exceeding those limits with a file auth message.

### Content-Addressable Storage

Files are stored using their **Merkle root hash (contentId)** as the identifier. This provides:

- **Deduplication**: Identical files share the same contentId, enabling efficient storage
- **Integrity**: ContentId changes if any chunk is modified, ensuring tamper detection
- **Verification**: Clients can verify file integrity using Merkle proofs without downloading the entire file
- **Persistence**: The contentId serves as a permanent identifier for the file, independent of upload sessions

**File ID Lifecycle**:

1. **Upload Initiation**: Client generates a temporary UUID as `fileId` for the upload session
2. **Chunk Transfer**: All chunks reference this temporary UUID
3. **Upload Completion**: Server computes Merkle root hash from all chunks
4. **Final ID**: Client receives the Merkle root hash (base64-encoded) as the permanent `fileId`
5. **Future Downloads**: The permanent `fileId` (Merkle root hash) is used to request the file

### Encryption Support

Files can be encrypted before chunking. The encrypted flag in file messages indicates whether the chunk data is encrypted. Encryption is handled at the application layer before protocol encoding.

**Encryption Details**:

- When encryption is enabled, chunks are encrypted before being sent
- Encrypted chunks are smaller than unencrypted chunks (see `ENCRYPTED_CHUNK_SIZE` constant)
- The file size reported in the upload message includes encryption overhead
- Encryption overhead = `numberOfChunks × (CHUNK_SIZE - ENCRYPTED_CHUNK_SIZE)`
- The same encryption key must be provided for both upload and download operations
- Chunks are decrypted after Merkle verification during download

This protocol ensures efficient, type-safe communication for collaborative editing applications while maintaining compatibility with the Y.js ecosystem and providing robust file transfer capabilities with integrity verification.
