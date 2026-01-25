---
name: IndexedDB encrypted updates cache
overview: Add IndexedDB storage for encrypted updates in the EncryptionClient to cache updates locally for faster reconnection. This will be implemented as an external helper utility that stores encrypted updates and seen messages mapping in the same IndexedDB database as the Provider but in separate object stores.
todos: []
isProject: false
---

# IndexedDB Encrypted Updates Cache

## Overview

Add IndexedDB persistence for encrypted updates in the `EncryptionClient` to cache updates locally, enabling faster reconnection without re-fetching all updates from the server.

## Current State

- `EncryptionClient` in [`src/transports/encrypted/client.ts`](src/transports/encrypted/client.ts) handles encrypted updates
- Playground example in [`playground/src/utils/encrypted.tsx`](playground/src/utils/encrypted.tsx) uses localStorage for caching
- Provider uses `y-indexeddb` for Y.Doc persistence in the same database
- Updates are stored via `getEncryptedMessageUpdate` callback and `seen-update`/`update-seen-messages` events

## Implementation Plan

### 1. Create IndexedDB Helper Utility

Create a new file [`src/transports/encrypted/indexeddb-storage.ts`](src/transports/encrypted/indexeddb-storage.ts) that provides:

- **Database Management**: Opens/creates the same IndexedDB database as Provider (using the same prefix pattern)
- **Object Stores**:
  - `encrypted-updates`: Stores encrypted update payloads (key: messageId, value: encrypted binary)
  - `seen-messages`: Stores the seen messages mapping (key: document name, value: SeenMessageMapping JSON)
- **API Methods**:
  - `getEncryptedMessageUpdate(messageId)`: Retrieve encrypted update from IndexedDB
  - `storeEncryptedUpdate(messageId, payload)`: Store encrypted update
  - `loadSeenMessages(document)`: Load seen messages mapping
  - `storeSeenMessages(document, seenMessages)`: Store seen messages mapping
  - `initialize(document, indexedDBPrefix)`: Initialize database and object stores

**Key Implementation Details**:

- Use the same database name pattern as Provider: `${indexedDBPrefix}${document}`
- Handle database versioning to add object stores if they don't exist
- Use immediate writes (no batching)
- Store encrypted updates as Uint8Array (IndexedDB supports ArrayBuffer/Uint8Array)
- Store seen messages as JSON string

### 2. Update Playground Example

Modify [`playground/src/utils/encrypted.tsx`](playground/src/utils/encrypted.tsx) to:

- Replace localStorage implementation with IndexedDB helper
- Use the helper's `getEncryptedMessageUpdate` function
- Wire up `seen-update` and `update-seen-messages` events to IndexedDB storage
- Load seen messages from IndexedDB on initialization
- Match the Provider's `indexedDBPrefix` for consistency

### 3. Database Structure

The IndexedDB database will have:

- **Database name**: `${indexedDBPrefix}${document}` (same as Provider)
- **Object stores**:
  - `updates` (managed by y-indexeddb for Y.Doc)
  - `meta` (managed by y-indexeddb)
  - `encrypted-updates` (new - for encrypted update cache)
  - `seen-messages` (new - for seen messages mapping)

### 4. Error Handling

- Handle IndexedDB availability (fallback gracefully if not available)
- Handle database version conflicts
- Handle quota exceeded errors
- Provide clear error messages

## Files to Create/Modify

1. **Create**: [`src/transports/encrypted/indexeddb-storage.ts`](src/transports/encrypted/indexeddb-storage.ts)
   - IndexedDB helper utility with all storage operations

2. **Modify**: [`playground/src/utils/encrypted.tsx`](playground/src/utils/encrypted.tsx)
   - Replace localStorage with IndexedDB helper
   - Update initialization and event handlers

## Data Flow

```
EncryptionClient
  ├─ "seen-update" event → IndexedDB.storeEncryptedUpdate()
  ├─ "update-seen-messages" event → IndexedDB.storeSeenMessages()
  └─ getEncryptedMessageUpdate() → IndexedDB.getEncryptedMessageUpdate()
       └─ Falls back to server if not in IndexedDB
```

## Benefits

- Faster reconnection (updates already cached locally)
- Works offline (can load cached updates without network)
- Better storage limits than localStorage (IndexedDB has larger quotas)
- Shared database with Provider (efficient storage management)
- No cleanup needed (as per requirements)

## Testing Considerations

- Test with multiple documents (different databases)
- Test database version upgrades
- Test IndexedDB quota limits
- Test fallback behavior when IndexedDB unavailable
- Verify updates are correctly stored and retrieved
