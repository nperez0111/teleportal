# Awareness Query Implementation

## Overview

I have successfully implemented a new "query awareness" payload type for the existing Awareness Message class. This allows clients to request and receive current awareness information from the server.

## What Was Implemented

### 1. New Message Type: `awareness-query`

- **Message Type ID**: `2` (binary encoded)
- **Purpose**: Request all current awareness information from the server
- **Difference from `awareness-request`**: 
  - `awareness-request` (type 1): Returns only the local client's awareness state
  - `awareness-query` (type 2): Returns ALL current awareness information from all connected clients

### 2. Type Definitions Added

**File: `src/lib/protocol/types.ts`**
```typescript
// New message type
export type AwarenessQueryMessage = Tag<Uint8Array, "awareness-query">;

// New decoded message type  
export type DecodedAwarenessQuery = {
  type: "awareness-query";
};

// Updated union type
export type AwarenessStep = AwarenessRequestMessage | AwarenessUpdateMessage | AwarenessQueryMessage;
```

### 3. Message Class Support

**File: `src/lib/protocol/message-types.ts`**
```typescript
// Updated AwarenessMessage constructor to accept new payload type
constructor(
  public document: string,
  public payload: DecodedAwarenessUpdateMessage | DecodedAwarenessRequest | DecodedAwarenessQuery,
  context?: Context,
  public encrypted: boolean = false,
  encoded?: BinaryMessage,
)
```

### 4. Binary Encoding/Decoding

**File: `src/lib/protocol/encode.ts`**
```typescript
case "awareness-query": {
  // message type
  encoding.writeUint8(encoder, 2);  // Binary message type 2
  break;
}
```

**File: `src/lib/protocol/decode.ts`**
```typescript
case 0x02: {
  return {
    type: "awareness-query",
  } as E;
}
```

### 5. YDoc Transport Handler

**File: `src/transports/ydoc/index.ts`**
```typescript
case "awareness-query": {
  // Respond with all current awareness information
  observer.call(
    "message",
    new AwarenessMessage(
      document,
      {
        type: "awareness-update",
        update: encodeAwarenessUpdate(awareness, Array.from(awareness.getStates().keys())) as AwarenessUpdateMessage,
      },
      {
        clientId: "local",
      },
    ),
  );
  break;
}
```

## How It Works

### Client Workflow

1. **Send Query**: Client sends an `awareness-query` message to the server
   ```typescript
   const queryMessage = new AwarenessMessage("doc-name", {
     type: "awareness-query"
   }, { clientId: "client-123" });
   ```

2. **Server Response**: Server automatically responds with an `awareness-update` containing all current awareness information
   - Unlike `awareness-request` which only returns the local client's state
   - `awareness-query` returns awareness data for ALL connected clients

3. **Binary Encoding**: The message is encoded to binary format compatible with Y.js protocols
   - Uses message type `2` for `awareness-query`
   - No additional payload data needed (just the type identifier)

### Key Differences

| Feature | `awareness-request` | `awareness-query` |
|---------|-------------------|------------------|
| Message Type ID | 1 | 2 |
| Response Scope | Local client only | All clients |
| Use Case | Get specific client's state | Get complete awareness picture |
| Payload Size | Smaller (1 client) | Larger (all clients) |

## Integration Points

The implementation integrates seamlessly with:

- ✅ **Existing Message Types**: Extends current awareness message infrastructure
- ✅ **Binary Protocol**: Compatible with Y.js binary encoding/decoding
- ✅ **Transport Layer**: Works with ydoc transport without breaking changes
- ✅ **Type Safety**: Full TypeScript support with proper type definitions
- ✅ **Encryption**: Supports encrypted messages like other message types

## Usage Example

```typescript
import { AwarenessMessage } from "teleportal/protocol";

// Create a query awareness message
const queryMessage = new AwarenessMessage(
  "my-document",
  { type: "awareness-query" },
  { clientId: "my-client" }
);

// Send through transport - server will automatically respond with
// an awareness-update containing all current awareness information
```

## Files Modified

1. `src/lib/protocol/types.ts` - Added new type definitions
2. `src/lib/protocol/message-types.ts` - Updated AwarenessMessage constructor
3. `src/lib/protocol/decode.ts` - Added decoding for message type 2
4. `src/lib/protocol/encode.ts` - Added encoding for awareness-query
5. `src/transports/ydoc/index.ts` - Added handler for awareness-query messages

## Testing

The implementation has been verified for:
- ✅ Type safety (TypeScript compilation)
- ✅ Binary encoding/decoding compatibility
- ✅ Integration with existing awareness message flow
- ✅ Proper response generation in ydoc transport

This implementation provides a clean, efficient way for clients to query the current awareness state without waiting for the default 30-second awareness sync intervals.