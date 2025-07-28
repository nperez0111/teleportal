import { DocMessage } from "teleportal";
import { Sedimentree } from "./sedimentree";

console.log("🌐 Sedimentree Wire Representation Analysis\n");

// Create a simple sedimentree for analysis
const sedimentree = new Sedimentree("test-doc", {
  maxDepth: 3,
  maxChildren: 2,
  maxMessages: 10,
  enableCompaction: true,
  compactionStrategy: "hybrid",
});
// Add messages to create a deep tree
let lastMsgId = null;
for (let i = 0; i < 100; i++) {
  const msg = new DocMessage("test-doc", {
    type: "update",
    update: new Uint8Array([i, i + 1, i + 2]) as any,
  });

  if (lastMsgId === null) {
    // First message is root
    lastMsgId = sedimentree.addMessage(msg);
  } else {
    // Add as child of previous message
    lastMsgId = sedimentree.addMessage(msg, lastMsgId);
  }
}

console.log("📊 Current Tree Structure:");
console.log(sedimentree.visualize());

console.log("\n🔍 Internal Data Structure:");
console.log("The sedimentree maintains these internal structures:");

// Show the internal structure (using public API)
console.log("\n1. Nodes Map:");
for (const id of sedimentree.getAllMessageIds()) {
  const node = sedimentree.getNode(id);
  if (node) {
    console.log(`  ${id.substring(0, 8)}... → {
    id: "${id.substring(0, 8)}...",
    timestamp: ${node.timestamp},
    parentId: ${node.parentId ? `"${node.parentId.substring(0, 8)}..."` : "null"},
    children: [${node.children.map((c) => `"${c.substring(0, 8)}..."`).join(", ")}],
    depth: ${node.depth},
    compacted: ${node.compacted},
    metadata: ${JSON.stringify(node.metadata)}
  }`);
  }
}

console.log("\n2. Root Nodes Set:");
const rootNodeIds = sedimentree
  .getAllMessageIds()
  .filter((id) => !sedimentree.getNode(id)?.parentId);
console.log(
  `  [${rootNodeIds.map((id) => `"${id.substring(0, 8)}..."`).join(", ")}]`,
);

console.log("\n3. Configuration:");
const config = {
  maxDepth: 3,
  maxChildren: 2,
  maxMessages: 10,
  enableCompaction: true,
  compactionStrategy: "hybrid" as const,
};
console.log(`  ${JSON.stringify(config, null, 2)}`);

console.log("\n🌐 Wire Representation:");
console.log("When serialized for network transmission, the structure becomes:");

const serialized = sedimentree.serialize();
const decoded = JSON.parse(
  new TextDecoder().decode(
    new Uint8Array(Array.from(atob(serialized), (c) => c.charCodeAt(0))),
  ),
);

console.log("\nSerialized JSON Structure:");
console.log(JSON.stringify(decoded, null, 2));

console.log("\n📏 Size Analysis:");
console.log(`- Raw JSON size: ${JSON.stringify(decoded).length} characters`);
console.log(`- Base64 encoded: ${serialized.length} characters`);
console.log(
  `- Compression ratio: ${(JSON.stringify(decoded).length / serialized.length).toFixed(2)}x`,
);

console.log("\n🔧 Wire Protocol Optimization:");
console.log("The wire representation is optimized for:");

console.log("\n1. Minimal Data:");
console.log("   - Only essential fields are included");
console.log("   - Message content is not duplicated");
console.log("   - Compacted nodes reduce tree size");

console.log("\n2. Efficient Encoding:");
console.log("   - Base64 encoding for binary safety");
console.log("   - JSON structure for easy parsing");
console.log("   - Compressed message IDs");

console.log("\n3. Network Efficiency:");
console.log("   - Small payload size (${serialized.length} chars)");
console.log("   - Self-contained structure");
console.log("   - No external dependencies");

console.log("\n📋 Wire Protocol Schema:");
console.log(`
interface WireSedimentree {
  document: string;                    // Document identifier
  config: {                           // Configuration
    maxDepth: number;
    maxChildren: number;
    maxMessages: number;
    enableCompaction: boolean;
    compactionStrategy: "depth" | "children" | "hybrid";
  };
  nodes: {                            // Message nodes
    [messageId: string]: {
      timestamp: number;              // Creation timestamp
      parentId: string | null;        // Parent message ID
      children: string[];             // Child message IDs
      depth: number;                  // Tree depth
      compacted: boolean;             // Compaction status
      metadata?: Record<string, any>; // Optional metadata
      // For compacted nodes:
      compactedMessages?: string[];   // IDs of compacted messages
      rootMessageId?: string;         // Root of compacted subtree
    };
  };
  rootNodes: string[];                // Root message IDs
}
`);

console.log("\n🚀 Usage Example:");
console.log(`
// Sending over WebSocket
const wireData = sedimentree.serialize();
websocket.send(JSON.stringify({
  type: "sedimentree-sync",
  data: wireData
}));

// Receiving and reconstructing
const received = JSON.parse(message);
const sedimentree = Sedimentree.deserialize(received.data);
`);

console.log("\n✨ Wire representation complete! The sedimentree efficiently");
console.log(
  "transmits its structure while maintaining all essential information.",
);
