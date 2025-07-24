# Encryption State Vector

The Encryption State Vector is a component that tracks all messages received for encrypted documents, enabling efficient synchronization between clients and servers. It allows clients to send only the messages they haven't seen yet, optimizing bandwidth and reducing redundant message transmission.

## Features

- **Message Tracking**: Maintains a complete history of all messages received for each document
- **Client Synchronization**: Tracks the last message each client has seen
- **Efficient Sync**: Only sends messages that clients haven't received yet
- **Compression**: Provides compression for efficient transmission of state vectors
- **Serialization**: Supports serialization/deserialization for persistence
- **Pruning**: Prevents unbounded growth by removing old messages
- **Multi-Document Support**: Manages state vectors for multiple documents

## Core Components

### EncryptionStateVector

The main class that tracks messages for a single document.

```typescript
import { EncryptionStateVector } from "teleportal/encryption-state-vector";

// Create a state vector for a document
const stateVector = new EncryptionStateVector("my-document");

// Add messages as they arrive
stateVector.addMessage(message);

// Check if a message has been received
const hasMessage = stateVector.hasMessage(messageId);

// Get all message IDs in order
const allMessageIds = stateVector.getAllMessageIds();

// Track client synchronization
stateVector.updateLastSyncedMessage("client-1", messageId);

// Get messages a client hasn't seen
const unseenMessages = stateVector.getUnseenMessages("client-1");
```

### EncryptionStateVectorManager

Manages multiple state vectors across different documents.

```typescript
import { EncryptionStateVectorManager } from "teleportal/encryption-state-vector";

// Create a manager
const manager = new EncryptionStateVectorManager();

// Add messages from different documents
manager.addMessage(docMessage1);
manager.addMessage(docMessage2);

// Get unseen messages for a client and document
const unseenMessages = manager.getUnseenMessages("document-1", "client-1");

// Update client sync state
manager.updateLastSyncedMessage("document-1", "client-1", messageId);
```

## Usage Scenarios

### Server-Side Message Tracking

```typescript
import { EncryptionStateVectorManager } from "teleportal/encryption-state-vector";
import { encryptUpdate } from "teleportal/encryption-key";

class EncryptedServer {
  private stateManager = new EncryptionStateVectorManager();
  
  async handleMessage(message: Message<any>) {
    // Add message to state vector
    this.stateManager.addMessage(message);
    
    // Broadcast to other clients, but only send unseen messages
    for (const clientId of this.getConnectedClients()) {
      if (clientId !== message.context.clientId) {
        const unseenMessages = this.stateManager.getUnseenMessages(
          message.document, 
          clientId
        );
        
        // Send only unseen messages
        await this.sendMessagesToClient(clientId, unseenMessages);
      }
    }
  }
  
  async onClientSync(clientId: string, document: string, lastKnownMessageId: string) {
    // Update what the client has seen
    this.stateManager.updateLastSyncedMessage(document, clientId, lastKnownMessageId);
    
    // Send any messages they haven't seen
    const unseenMessages = this.stateManager.getUnseenMessages(document, clientId);
    await this.sendMessagesToClient(clientId, unseenMessages);
  }
}
```

### Client-Side Synchronization

```typescript
import { EncryptionStateVector } from "teleportal/encryption-state-vector";

class EncryptedClient {
  private stateVector = new EncryptionStateVector("my-document");
  
  async syncWithServer() {
    // Get all messages we've seen
    const knownMessageIds = this.stateVector.getAllMessageIds();
    
    // Tell server what we've seen
    await this.sendToServer({
      type: "sync-request",
      document: "my-document",
      knownMessages: knownMessageIds
    });
  }
  
  async handleMessage(message: Message<any>) {
    // Add to our state vector
    this.stateVector.addMessage(message);
    
    // Process the message
    await this.processMessage(message);
  }
}
```

### Compression and Serialization

```typescript
// Compress state vector for efficient transmission
const compressed = stateVector.compress();

// Create from compressed data
const newStateVector = EncryptionStateVector.fromCompressed(document, compressed);

// Serialize for storage
const serialized = stateVector.serialize();

// Deserialize from storage
const restoredStateVector = EncryptionStateVector.deserialize(serialized);

// Serialize entire manager
const managerSerialized = manager.serialize();
const restoredManager = EncryptionStateVectorManager.deserialize(managerSerialized);
```

### Pruning Old Messages

```typescript
// Prevent unbounded growth by keeping only recent messages
stateVector.prune(1000); // Keep only last 1000 messages

// This is useful for long-running servers to prevent memory issues
setInterval(() => {
  for (const [document, stateVector] of manager.getAllStateVectors()) {
    stateVector.prune(1000);
  }
}, 60000); // Prune every minute
```

## Integration with Existing Protocol

The encryption state vector integrates seamlessly with the existing teleportal protocol:

```typescript
import { EncryptionStateVectorManager } from "teleportal/encryption-state-vector";
import { encryptUpdate, decryptUpdate } from "teleportal/encryption-key";
import { DocMessage, AwarenessMessage } from "teleportal/protocol";

class EncryptedDocumentHandler {
  private stateManager = new EncryptionStateVectorManager();
  private encryptionKey: CryptoKey;
  
  constructor(encryptionKey: CryptoKey) {
    this.encryptionKey = encryptionKey;
  }
  
  async handleDocMessage(message: DocMessage<any>) {
    // Decrypt if needed
    if (message.encrypted) {
      const decryptedUpdate = await decryptUpdate(this.encryptionKey, message.payload.update);
      // Process decrypted update...
    }
    
    // Add to state vector
    this.stateManager.addMessage(message);
    
    // Sync with clients
    await this.syncWithClients(message.document);
  }
  
  async syncWithClients(document: string) {
    for (const clientId of this.getConnectedClients()) {
      const unseenMessages = this.stateManager.getUnseenMessages(document, clientId);
      
      for (const messageId of unseenMessages) {
        // Get original message and send to client
        const originalMessage = await this.getStoredMessage(messageId);
        await this.sendToClient(clientId, originalMessage);
      }
    }
  }
}
```

## Benefits

1. **Bandwidth Efficiency**: Only sends messages that clients haven't seen
2. **Reduced Latency**: Clients can quickly identify what they're missing
3. **Scalability**: Supports multiple documents and clients efficiently
4. **Reliability**: Ensures no messages are lost during synchronization
5. **Flexibility**: Works with both encrypted and unencrypted messages
6. **Memory Management**: Pruning prevents unbounded memory growth

## Advanced Features

### Message Deduplication

The state vector automatically handles message deduplication:

```typescript
// Adding the same message twice won't create duplicates
stateVector.addMessage(message);
stateVector.addMessage(message); // This won't add a duplicate
```

### Merging State Vectors

You can merge state vectors from different sources:

```typescript
const stateVector1 = new EncryptionStateVector("doc1");
const stateVector2 = new EncryptionStateVector("doc1");

// Add different messages to each
stateVector1.addMessage(message1);
stateVector2.addMessage(message2);

// Merge them
stateVector1.merge(stateVector2);
// Now stateVector1 contains both messages
```

### Range-Based Synchronization

For future optimization, the compression system supports range-based message tracking:

```typescript
// Current implementation uses individual message IDs
// Future versions could use ranges for sequential message IDs
const compressed = stateVector.compress();
// { ranges: [...], individual: [...] }
```

## Error Handling

The system includes comprehensive error handling:

```typescript
try {
  // Will throw if message belongs to wrong document
  stateVector.addMessage(wrongDocumentMessage);
} catch (error) {
  console.error("Document mismatch:", error.message);
}

try {
  // Will throw if message ID doesn't exist
  stateVector.updateLastSyncedMessage("client-1", "non-existent-id");
} catch (error) {
  console.error("Message not found:", error.message);
}
```

## Performance Considerations

- **Memory Usage**: Use pruning to limit memory growth
- **Serialization**: Serialize/deserialize only when necessary
- **Compression**: Use compression for large state vectors
- **Batch Operations**: Process multiple messages together when possible

## Future Enhancements

The current implementation provides a solid foundation and can be extended with:

1. **Sequential Message IDs**: For better range compression
2. **Bloom Filters**: For approximate membership testing
3. **Delta Compression**: For incremental state updates
4. **Persistent Storage**: Direct integration with storage backends
5. **Metrics**: Performance monitoring and analytics