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
  │─────── Awareness Update ─────▶│  (user cursor/selection)
  │                                │
  │◀────── Awareness Update ──────│  (other clients' user states)
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
```

This protocol ensures efficient, type-safe communication for collaborative editing applications while maintaining compatibility with the Y.js ecosystem.
