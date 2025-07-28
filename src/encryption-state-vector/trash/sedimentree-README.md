# Sedimentree Implementation

A tree-based data structure for efficient message history tracking in collaborative editing systems, based on the [Keyhive design document](https://github.com/inkandswitch/keyhive/blob/main/design/sedimentree.md).

## Overview

The sedimentree maintains a tree structure of messages where each message becomes a node in the tree. The tree grows over time as new messages are added, and old branches can be compacted to maintain performance and prevent unbounded growth.

## Key Features

- **Tree-based message history** with parent-child relationships
- **Automatic compaction** to prevent unbounded growth
- **Efficient querying** of message ancestry and descendants
- **Multiple compaction strategies** (depth, children, hybrid)
- **Serialization** for persistence
- **Memory management** with configurable limits
- **Visual tree representation** for debugging

## Usage

```typescript
import { Sedimentree } from "teleportal/encryption-state-vector";

// Create a sedimentree for a document
const sedimentree = new Sedimentree("my-document", {
  maxDepth: 100,
  maxChildren: 50,
  maxMessages: 10000,
  enableCompaction: true,
  compactionStrategy: "hybrid",
});

// Add messages (requires proper Message objects from teleportal protocol)
// sedimentree.addMessage(message, parentId);

// Query the tree
const hasMessage = sedimentree.hasMessage("message-id");
const ancestry = sedimentree.getAncestry("message-id");
const descendants = sedimentree.getDescendants("message-id");
const latest = sedimentree.getLatestMessage();

// Get statistics
const stats = sedimentree.getStats();

// Serialize for persistence
const serialized = sedimentree.serialize();
const deserialized = Sedimentree.deserialize(serialized);

// Visualize the tree
console.log(sedimentree.visualize());
```

## Configuration Options

```typescript
interface SedimentreeConfig {
  maxDepth: number;           // Maximum depth before compaction
  maxChildren: number;        // Maximum children before compaction
  maxMessages: number;        // Maximum messages to keep in memory
  enableCompaction: boolean;  // Whether to enable automatic compaction
  compactionStrategy: 'depth' | 'children' | 'hybrid';
}
```

## Compaction Strategies

- **`depth`**: Compact when tree depth exceeds `maxDepth`
- **`children`**: Compact when node has more than `maxChildren` children
- **`hybrid`**: Compact when either depth or children limit is exceeded

## Tree Structure

```
└── root-message
    ├── child-message-1
    │   └── grandchild-message-1
    └── child-message-2
        └── grandchild-message-2
```

## Performance Characteristics

- **Memory usage**: ~200 bytes per node
- **Compaction**: Reduces tree depth while maintaining history
- **Query performance**: O(depth) for ancestry, O(descendants) for descendants
- **Serialization**: Efficient base64 encoding

## Integration with Teleportal

The sedimentree is designed to work with the teleportal protocol's Message interface. To use it with real messages:

1. Create proper Message objects using the teleportal protocol
2. Pass them to `addMessage()` method
3. The tree will automatically handle parent-child relationships
4. Use the tree for efficient message history queries

## Example Use Cases

1. **Collaborative document editing**: Track document change history
2. **Message history tracking**: Maintain complete message ancestry
3. **Conflict resolution**: Understand message dependencies
4. **State synchronization**: Efficiently sync client states
5. **Audit trails**: Complete history of all operations

## Testing

Run the test examples:

```bash
bun run src/encryption-state-vector/sedimentree-example.ts
bun run src/encryption-state-vector/sedimentree-test.ts
```

## Design Notes

This implementation follows the Keyhive sedimentree design with some adaptations for the teleportal ecosystem:

- Uses TypeScript for type safety
- Integrates with teleportal's Message interface
- Provides serialization for persistence
- Includes visualization for debugging
- Supports multiple compaction strategies

The sedimentree provides a foundation for efficient message history tracking in collaborative applications while maintaining performance through automatic compaction.
