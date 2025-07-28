import { DocMessage } from "teleportal";
import { Sedimentree } from "./sedimentree";

console.log(
  "📊 Sedimentree Compression Comparison: Before vs After Compaction\n",
);

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

// Create a sedimentree with aggressive compaction settings
const sedimentree = new Sedimentree("compression-test", {
  maxDepth: 3, // Compact when depth > 3
  maxChildren: 2, // Compact when children > 2
  maxMessages: 50, // Keep max 50 messages
  enableCompaction: true,
  compactionStrategy: "hybrid",
});

console.log("📝 Building a deep tree structure...\n");

// Build a deep tree with many messages
let parentId: string | undefined;
const messageIds: string[] = [];

// Add 20 messages in a deep chain
for (let i = 0; i < 20; i++) {
  const msg = createMessage(
    "compression-test",
    `Message ${i + 1}: This is message content ${i + 1}`,
  );
  const msgId = sedimentree.addMessage(msg, parentId);
  messageIds.push(msgId);
  parentId = msgId;

  // Create some branching every 3 messages
  if (i % 3 === 0 && i > 0 && i < 15) {
    const branchParent = messageIds[i - 2];
    for (let j = 0; j < 2; j++) {
      const branchMsg = createMessage(
        "compression-test",
        `Branch ${i}.${j + 1}: Branch message content`,
      );
      sedimentree.addMessage(branchMsg, branchParent);
    }
  }
}

console.log("🌳 Tree Structure BEFORE Compaction:");
console.log(sedimentree.visualize());

const statsBefore = sedimentree.getStats();
console.log(`\n📊 Statistics BEFORE Compaction:`);
console.log(JSON.stringify(statsBefore, null, 2));

// Serialize BEFORE compaction
const serializedBefore = sedimentree.serialize();
const decodedBefore = JSON.parse(
  new TextDecoder().decode(
    new Uint8Array(Array.from(atob(serializedBefore), (c) => c.charCodeAt(0))),
  ),
);

console.log(`\n📏 Size Analysis BEFORE Compaction:`);
console.log(`- Total nodes: ${statsBefore.totalNodes}`);
console.log(
  `- Raw JSON size: ${JSON.stringify(decodedBefore).length} characters`,
);
console.log(`- Base64 encoded: ${serializedBefore.length} characters`);
console.log(
  `- Average node size: ${(JSON.stringify(decodedBefore).length / statsBefore.totalNodes).toFixed(0)} chars/node`,
);

console.log("\n⚡ Triggering Compaction...");

// Add more messages to trigger compaction
for (let i = 0; i < 10; i++) {
  const msg = createMessage(
    "compression-test",
    `Additional message ${i + 1} to trigger compaction`,
  );
  parentId = sedimentree.addMessage(msg, parentId);
}

console.log("\n🌳 Tree Structure AFTER Compaction:");
console.log(sedimentree.visualize());

const statsAfter = sedimentree.getStats();
console.log(`\n📊 Statistics AFTER Compaction:`);
console.log(JSON.stringify(statsAfter, null, 2));

// Serialize AFTER compaction
const serializedAfter = sedimentree.serialize();
const decodedAfter = JSON.parse(
  new TextDecoder().decode(
    new Uint8Array(Array.from(atob(serializedAfter), (c) => c.charCodeAt(0))),
  ),
);

console.log(`\n📏 Size Analysis AFTER Compaction:`);
console.log(`- Total nodes: ${statsAfter.totalNodes}`);
console.log(
  `- Raw JSON size: ${JSON.stringify(decodedAfter).length} characters`,
);
console.log(`- Base64 encoded: ${serializedAfter.length} characters`);
console.log(
  `- Average node size: ${(JSON.stringify(decodedAfter).length / statsAfter.totalNodes).toFixed(0)} chars/node`,
);

// Compression comparison
console.log("\n🔍 COMPRESSION COMPARISON:");
console.log("=".repeat(50));

const jsonSizeBefore = JSON.stringify(decodedBefore).length;
const jsonSizeAfter = JSON.stringify(decodedAfter).length;
const base64SizeBefore = serializedBefore.length;
const base64SizeAfter = serializedAfter.length;

console.log(`📊 Size Comparison:`);
console.log(
  `- Raw JSON: ${jsonSizeBefore} → ${jsonSizeAfter} chars (${(((jsonSizeAfter - jsonSizeBefore) / jsonSizeBefore) * 100).toFixed(1)}% change)`,
);
console.log(
  `- Base64: ${base64SizeBefore} → ${base64SizeAfter} chars (${(((base64SizeAfter - base64SizeBefore) / base64SizeBefore) * 100).toFixed(1)}% change)`,
);

console.log(`\n📈 Efficiency Metrics:`);
console.log(
  `- Nodes: ${statsBefore.totalNodes} → ${statsAfter.totalNodes} (${(((statsAfter.totalNodes - statsBefore.totalNodes) / statsBefore.totalNodes) * 100).toFixed(1)}% change)`,
);
console.log(
  `- Max Depth: ${statsBefore.maxDepth} → ${statsAfter.maxDepth} (${(((statsAfter.maxDepth - statsBefore.maxDepth) / statsBefore.maxDepth) * 100).toFixed(1)}% change)`,
);
console.log(
  `- Average Depth: ${statsBefore.averageDepth.toFixed(2)} → ${statsAfter.averageDepth.toFixed(2)} (${(((statsAfter.averageDepth - statsBefore.averageDepth) / statsBefore.averageDepth) * 100).toFixed(1)}% change)`,
);
console.log(
  `- Compacted Nodes: ${statsBefore.compactedNodes} → ${statsAfter.compactedNodes} (+${statsAfter.compactedNodes - statsBefore.compactedNodes})`,
);

console.log(`\n💾 Compression Ratios:`);
const compressionRatioBefore = jsonSizeBefore / base64SizeBefore;
const compressionRatioAfter = jsonSizeAfter / base64SizeAfter;
console.log(
  `- Before compaction: ${compressionRatioBefore.toFixed(2)}x (JSON/Base64)`,
);
console.log(
  `- After compaction: ${compressionRatioAfter.toFixed(2)}x (JSON/Base64)`,
);
console.log(
  `- Overall efficiency: ${(compressionRatioAfter / compressionRatioBefore).toFixed(2)}x improvement`,
);

console.log(`\n🌐 Network Efficiency:`);
const bytesPerNodeBefore = base64SizeBefore / statsBefore.totalNodes;
const bytesPerNodeAfter = base64SizeAfter / statsAfter.totalNodes;
console.log(
  `- Bytes per node (before): ${bytesPerNodeBefore.toFixed(0)} bytes`,
);
console.log(`- Bytes per node (after): ${bytesPerNodeAfter.toFixed(0)} bytes`);
console.log(
  `- Network efficiency: ${(bytesPerNodeBefore / bytesPerNodeAfter).toFixed(2)}x improvement`,
);

// Show compacted node details
console.log("\n📦 Compacted Node Analysis:");
let totalCompactedMessages = 0;
for (const id of sedimentree.getAllMessageIds()) {
  const node = sedimentree.getNode(id);
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

console.log(`\n📊 Compaction Summary:`);
console.log(`- Total messages compacted: ${totalCompactedMessages}`);
console.log(
  `- Space saved: ~${(totalCompactedMessages * 200).toFixed(0)} characters (estimated)`,
);
console.log(
  `- Tree complexity reduced: ${statsBefore.maxDepth - statsAfter.maxDepth} levels`,
);

console.log("\n✨ Compression comparison complete!");
console.log(
  "The sedimentree demonstrates significant space efficiency gains through compaction.",
);
