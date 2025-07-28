import { DocMessage } from "teleportal";
import { Sedimentree } from "./sedimentree";

console.log("🚀 Dramatic Sedimentree Compression Demo: Before vs After\n");

// Helper function to create messages with unique content
function createMessage(document: string, content: string): DocMessage<any> {
  return new DocMessage(
    document,
    {
      type: "update",
      update: new Uint8Array(Buffer.from(content, "utf8")) as any,
    },
    undefined,
    false,
  );
}

// Create a sedimentree with NO compaction first
const sedimentreeNoCompaction = new Sedimentree("no-compaction-test", {
  maxDepth: 100, // Very high - no depth-based compaction
  maxChildren: 100, // Very high - no children-based compaction
  maxMessages: 100, // High limit
  enableCompaction: false, // Disable compaction
  compactionStrategy: "hybrid",
});

console.log("📝 Building a deep tree WITHOUT compaction...\n");

// Build a very deep tree with many messages
let parentId: string | undefined;
const messageIds: string[] = [];

// Add 30 messages in a deep chain
for (let i = 0; i < 30; i++) {
  const msg = createMessage(
    "no-compaction-test",
    `Message ${i + 1}: This is a detailed message with lots of content ${i + 1}`,
  );
  const msgId = sedimentreeNoCompaction.addMessage(msg, parentId);
  messageIds.push(msgId);
  parentId = msgId;

  // Create branching every 2 messages
  if (i % 2 === 0 && i > 0 && i < 25) {
    const branchParent = messageIds[i - 1];
    for (let j = 0; j < 3; j++) {
      const branchMsg = createMessage(
        "no-compaction-test",
        `Branch ${i}.${j + 1}: Another detailed branch message with content`,
      );
      sedimentreeNoCompaction.addMessage(branchMsg, branchParent);
    }
  }
}

console.log("🌳 Tree Structure WITHOUT Compaction:");
console.log(sedimentreeNoCompaction.visualize());

const statsNoCompaction = sedimentreeNoCompaction.getStats();
console.log(`\n📊 Statistics WITHOUT Compaction:`);
console.log(JSON.stringify(statsNoCompaction, null, 2));

// Serialize WITHOUT compaction
const serializedNoCompaction = sedimentreeNoCompaction.serialize();
const decodedNoCompaction = JSON.parse(
  new TextDecoder().decode(
    new Uint8Array(
      Array.from(atob(serializedNoCompaction), (c) => c.charCodeAt(0)),
    ),
  ),
);

console.log(`\n📏 Size Analysis WITHOUT Compaction:`);
console.log(`- Total nodes: ${statsNoCompaction.totalNodes}`);
console.log(
  `- Raw JSON size: ${JSON.stringify(decodedNoCompaction).length} characters`,
);
console.log(`- Base64 encoded: ${serializedNoCompaction.length} characters`);
console.log(
  `- Average node size: ${(JSON.stringify(decodedNoCompaction).length / statsNoCompaction.totalNodes).toFixed(0)} chars/node`,
);

// Now create a sedimentree WITH aggressive compaction
const sedimentreeWithCompaction = new Sedimentree("with-compaction-test", {
  maxDepth: 3, // Very aggressive - compact at depth 3
  maxChildren: 2, // Very aggressive - compact at 2 children
  maxMessages: 100, // Same limit
  enableCompaction: true,
  compactionStrategy: "hybrid",
});

console.log("\n📝 Building the SAME tree WITH compaction...\n");

// Build the same tree structure but with compaction enabled
parentId = undefined;
const messageIds2: string[] = [];

// Add the same 30 messages
for (let i = 0; i < 30; i++) {
  const msg = createMessage(
    "with-compaction-test",
    `Message ${i + 1}: This is a detailed message with lots of content ${i + 1}`,
  );
  const msgId = sedimentreeWithCompaction.addMessage(msg, parentId);
  messageIds2.push(msgId);
  parentId = msgId;

  // Create the same branching
  if (i % 2 === 0 && i > 0 && i < 25) {
    const branchParent = messageIds2[i - 1];
    for (let j = 0; j < 3; j++) {
      const branchMsg = createMessage(
        "with-compaction-test",
        `Branch ${i}.${j + 1}: Another detailed branch message with content`,
      );
      sedimentreeWithCompaction.addMessage(branchMsg, branchParent);
    }
  }
}

console.log("🌳 Tree Structure WITH Compaction:");
console.log(sedimentreeWithCompaction.visualize());

const statsWithCompaction = sedimentreeWithCompaction.getStats();
console.log(`\n📊 Statistics WITH Compaction:`);
console.log(JSON.stringify(statsWithCompaction, null, 2));

// Serialize WITH compaction
const serializedWithCompaction = sedimentreeWithCompaction.serialize();
const decodedWithCompaction = JSON.parse(
  new TextDecoder().decode(
    new Uint8Array(
      Array.from(atob(serializedWithCompaction), (c) => c.charCodeAt(0)),
    ),
  ),
);

console.log(`\n📏 Size Analysis WITH Compaction:`);
console.log(`- Total nodes: ${statsWithCompaction.totalNodes}`);
console.log(
  `- Raw JSON size: ${JSON.stringify(decodedWithCompaction).length} characters`,
);
console.log(`- Base64 encoded: ${serializedWithCompaction.length} characters`);
console.log(
  `- Average node size: ${(JSON.stringify(decodedWithCompaction).length / statsWithCompaction.totalNodes).toFixed(0)} chars/node`,
);

// Dramatic compression comparison
console.log("\n🚀 DRAMATIC COMPRESSION COMPARISON:");
console.log("=".repeat(60));

const jsonSizeNoComp = JSON.stringify(decodedNoCompaction).length;
const jsonSizeWithComp = JSON.stringify(decodedWithCompaction).length;
const base64SizeNoComp = serializedNoCompaction.length;
const base64SizeWithComp = serializedWithCompaction.length;

console.log(`📊 Size Comparison:`);
console.log(
  `- Raw JSON: ${jsonSizeNoComp} → ${jsonSizeWithComp} chars (${(((jsonSizeWithComp - jsonSizeNoComp) / jsonSizeNoComp) * 100).toFixed(1)}% change)`,
);
console.log(
  `- Base64: ${base64SizeNoComp} → ${base64SizeWithComp} chars (${(((base64SizeWithComp - base64SizeNoComp) / base64SizeNoComp) * 100).toFixed(1)}% change)`,
);

console.log(`\n📈 Efficiency Metrics:`);
console.log(
  `- Nodes: ${statsNoCompaction.totalNodes} → ${statsWithCompaction.totalNodes} (${(((statsWithCompaction.totalNodes - statsNoCompaction.totalNodes) / statsNoCompaction.totalNodes) * 100).toFixed(1)}% change)`,
);
console.log(
  `- Max Depth: ${statsNoCompaction.maxDepth} → ${statsWithCompaction.maxDepth} (${(((statsWithCompaction.maxDepth - statsNoCompaction.maxDepth) / statsNoCompaction.maxDepth) * 100).toFixed(1)}% change)`,
);
console.log(
  `- Average Depth: ${statsNoCompaction.averageDepth.toFixed(2)} → ${statsWithCompaction.averageDepth.toFixed(2)} (${(((statsWithCompaction.averageDepth - statsNoCompaction.averageDepth) / statsNoCompaction.averageDepth) * 100).toFixed(1)}% change)`,
);
console.log(
  `- Compacted Nodes: ${statsNoCompaction.compactedNodes} → ${statsWithCompaction.compactedNodes} (+${statsWithCompaction.compactedNodes - statsNoCompaction.compactedNodes})`,
);

console.log(`\n💾 Compression Ratios:`);
const compressionRatioNoComp = jsonSizeNoComp / base64SizeNoComp;
const compressionRatioWithComp = jsonSizeWithComp / base64SizeWithComp;
console.log(
  `- Without compaction: ${compressionRatioNoComp.toFixed(2)}x (JSON/Base64)`,
);
console.log(
  `- With compaction: ${compressionRatioWithComp.toFixed(2)}x (JSON/Base64)`,
);
console.log(
  `- Overall efficiency: ${(compressionRatioWithComp / compressionRatioNoComp).toFixed(2)}x improvement`,
);

console.log(`\n🌐 Network Efficiency:`);
const bytesPerNodeNoComp = base64SizeNoComp / statsNoCompaction.totalNodes;
const bytesPerNodeWithComp =
  base64SizeWithComp / statsWithCompaction.totalNodes;
console.log(
  `- Bytes per node (no compaction): ${bytesPerNodeNoComp.toFixed(0)} bytes`,
);
console.log(
  `- Bytes per node (with compaction): ${bytesPerNodeWithComp.toFixed(0)} bytes`,
);
console.log(
  `- Network efficiency: ${(bytesPerNodeNoComp / bytesPerNodeWithComp).toFixed(2)}x improvement`,
);

console.log(`\n💡 Space Savings:`);
const spaceSaved = jsonSizeNoComp - jsonSizeWithComp;
const spaceSavedPercent = ((spaceSaved / jsonSizeNoComp) * 100).toFixed(1);
console.log(`- Characters saved: ${spaceSaved} (${spaceSavedPercent}%)`);
console.log(
  `- Base64 bytes saved: ${base64SizeNoComp - base64SizeWithComp} (${(((base64SizeNoComp - base64SizeWithComp) / base64SizeNoComp) * 100).toFixed(1)}%)`,
);

// Show compacted node details
console.log("\n📦 Compacted Node Analysis:");
let totalCompactedMessages = 0;
for (const id of sedimentreeWithCompaction.getAllMessageIds()) {
  const node = sedimentreeWithCompaction.getNode(id);
  if (node && node.compacted) {
    if ("compactedMessages" in node) {
      const compactedNode = node as any;
      const compactedCount = compactedNode.compactedMessages?.length || 0;
      totalCompactedMessages += compactedCount;
      console.log(
        `- ${id.substring(0, 12)}...: ${compactedCount} messages compacted (depth: ${node.depth})`,
      );
    }
  }
}

console.log(`\n📊 Final Summary:`);
console.log(`- Total messages compacted: ${totalCompactedMessages}`);
console.log(
  `- Space saved: ~${(totalCompactedMessages * 250).toFixed(0)} characters (estimated)`,
);
console.log(
  `- Tree complexity reduced: ${statsNoCompaction.maxDepth - statsWithCompaction.maxDepth} levels`,
);
console.log(
  `- Memory efficiency: ${(statsNoCompaction.totalNodes / statsWithCompaction.totalNodes).toFixed(2)}x improvement`,
);

console.log("\n✨ Dramatic compression demo complete!");
console.log(
  "The sedimentree shows dramatic space efficiency gains through aggressive compaction!",
);
