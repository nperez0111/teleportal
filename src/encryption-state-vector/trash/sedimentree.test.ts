import { describe, test, expect } from "bun:test";
import { Sedimentree, type SedimentreeMessageId } from "./sedimentree";
import { DocMessage, Update } from "teleportal";

// Helper function to create real messages for testing
function createTestMessage(
  document: string,
  encrypted: boolean = false,
  uniqueId: number = 0,
): DocMessage<any> {
  return new DocMessage(
    document,
    {
      type: "update",
      update: new Uint8Array([1, 2, 3, uniqueId]) as any,
    },
    undefined,
    encrypted,
  );
}

describe("Sedimentree", () => {
  test("should create empty sedimentree", () => {
    const sedimentree = new Sedimentree("test-doc");

    expect(sedimentree.getStats()).toEqual({
      totalNodes: 0,
      rootNodes: 0,
      maxDepth: 0,
      averageDepth: 0,
      compactedNodes: 0,
    });

    expect(sedimentree.getAllMessageIds()).toEqual([]);
    expect(sedimentree.hasMessage("any-id")).toBe(false);
  });

  test("should add messages and build tree structure", () => {
    const sedimentree = new Sedimentree("test-doc");

    // Add root message
    const msg1 = createTestMessage("test-doc", false, 1);
    const msg1Id = sedimentree.addMessage(msg1);
    expect(msg1Id).toBe(msg1.id);

    // Add child message
    const msg2 = createTestMessage("test-doc", false, 2);
    const msg2Id = sedimentree.addMessage(msg2, msg1.id);
    expect(msg2Id).toBe(msg2.id);

    // Add another child
    const msg3 = createTestMessage("test-doc", false, 3);
    const msg3Id = sedimentree.addMessage(msg3, msg1.id);
    expect(msg3Id).toBe(msg3.id);

    // Add grandchild
    const msg4 = createTestMessage("test-doc", false, 4);
    const msg4Id = sedimentree.addMessage(msg4, msg2.id);
    expect(msg4Id).toBe(msg4.id);

    expect(sedimentree.hasMessage(msg1.id)).toBe(true);
    expect(sedimentree.hasMessage(msg2.id)).toBe(true);
    expect(sedimentree.hasMessage(msg3.id)).toBe(true);
    expect(sedimentree.hasMessage(msg4.id)).toBe(true);
    expect(sedimentree.hasMessage("nonexistent")).toBe(false);

    expect(sedimentree.getAllMessageIds()).toContain(msg1.id);
    expect(sedimentree.getAllMessageIds()).toContain(msg2.id);
    expect(sedimentree.getAllMessageIds()).toContain(msg3.id);
    expect(sedimentree.getAllMessageIds()).toContain(msg4.id);

    const stats = sedimentree.getStats();
    expect(stats.totalNodes).toBe(4);
    expect(stats.rootNodes).toBe(1);
    expect(stats.maxDepth).toBe(2);
    expect(stats.averageDepth).toBe(1.0);
  });

  test("should get ancestry chain correctly", () => {
    const sedimentree = new Sedimentree("test-doc");

    // Build tree: msg1 -> msg2 -> msg3 -> msg4
    const msg1 = createTestMessage("test-doc", false, 1);
    const msg2 = createTestMessage("test-doc", false, 2);
    const msg3 = createTestMessage("test-doc", false, 3);
    const msg4 = createTestMessage("test-doc", false, 4);

    sedimentree.addMessage(msg1);
    sedimentree.addMessage(msg2, msg1.id);
    sedimentree.addMessage(msg3, msg2.id);
    sedimentree.addMessage(msg4, msg3.id);

    const ancestry = sedimentree.getAncestry(msg4.id);
    expect(ancestry).toEqual([msg1.id, msg2.id, msg3.id, msg4.id]);

    const ancestry2 = sedimentree.getAncestry(msg2.id);
    expect(ancestry2).toEqual([msg1.id, msg2.id]);

    const ancestry3 = sedimentree.getAncestry(msg1.id);
    expect(ancestry3).toEqual([msg1.id]);
  });

  test("should get descendants correctly", () => {
    const sedimentree = new Sedimentree("test-doc");

    // Build tree: msg1 -> msg2, msg3 -> msg4
    const msg1 = createTestMessage("test-doc", false, 5);
    const msg2 = createTestMessage("test-doc", false, 6);
    const msg3 = createTestMessage("test-doc", false, 7);
    const msg4 = createTestMessage("test-doc", false, 8);

    sedimentree.addMessage(msg1);
    sedimentree.addMessage(msg2, msg1.id);
    sedimentree.addMessage(msg3, msg1.id);
    sedimentree.addMessage(msg4, msg3.id);

    const descendants1 = sedimentree.getDescendants(msg1.id);
    expect(descendants1).toContain(msg2.id);
    expect(descendants1).toContain(msg3.id);
    expect(descendants1).toContain(msg4.id);
    expect(descendants1.length).toBe(3);

    const descendants2 = sedimentree.getDescendants(msg2.id);
    expect(descendants2).toEqual([]);

    const descendants3 = sedimentree.getDescendants(msg3.id);
    expect(descendants3).toEqual([msg4.id]);
  });

  test("should get messages since a given message", () => {
    const sedimentree = new Sedimentree("test-doc");

    // Build tree: msg1 -> msg2 -> msg3
    const msg1 = createTestMessage("test-doc", false, 9);
    const msg2 = createTestMessage("test-doc", false, 10);
    const msg3 = createTestMessage("test-doc", false, 11);

    sedimentree.addMessage(msg1);
    sedimentree.addMessage(msg2, msg1.id);
    sedimentree.addMessage(msg3, msg2.id);

    const messagesSince1 = sedimentree.getMessagesSince(msg1.id);
    expect(messagesSince1).toContain(msg2.id);
    expect(messagesSince1).toContain(msg3.id);
    expect(messagesSince1.length).toBe(2);

    const messagesSince2 = sedimentree.getMessagesSince(msg2.id);
    expect(messagesSince2).toEqual([msg3.id]);
  });

  test("should get latest message", () => {
    const sedimentree = new Sedimentree("test-doc");

    const msg1 = createTestMessage("test-doc", false, 12);
    const msg2 = createTestMessage("test-doc", false, 13);

    sedimentree.addMessage(msg1);
    sedimentree.addMessage(msg2, msg1.id);

    const latest = sedimentree.getLatestMessage();
    expect(latest).toBeTruthy(); // Should return a message ID
    expect(sedimentree.hasMessage(latest!)).toBe(true); // Should be a valid message ID
  });

  test("should throw error for wrong document", () => {
    const sedimentree = new Sedimentree("test-doc");

    const wrongDocMsg = createTestMessage("wrong-doc", false, 14);

    expect(() => {
      sedimentree.addMessage(wrongDocMsg);
    }).toThrow(
      "Message document wrong-doc does not match sedimentree document test-doc",
    );
  });

  test("should serialize and deserialize correctly", () => {
    const sedimentree = new Sedimentree("test-doc");

    const msg1 = createTestMessage("test-doc", false, 15);
    const msg2 = createTestMessage("test-doc", false, 16);

    sedimentree.addMessage(msg1);
    sedimentree.addMessage(msg2, msg1.id);

    const serialized = sedimentree.serialize();
    expect(typeof serialized).toBe("string");
    expect(serialized.length).toBeGreaterThan(0);

    const deserialized = Sedimentree.deserialize(serialized);
    expect(deserialized.getStats()).toEqual(sedimentree.getStats());
    expect(deserialized.getAllMessageIds()).toEqual(
      sedimentree.getAllMessageIds(),
    );
    expect(deserialized.hasMessage(msg1.id)).toBe(true);
    expect(deserialized.hasMessage(msg2.id)).toBe(true);
  });

  test("should merge sedimentrees correctly", () => {
    const sedimentree1 = new Sedimentree("test-doc");
    const sedimentree2 = new Sedimentree("test-doc");

    const msg1 = createTestMessage("test-doc", false, 17);
    const msg2 = createTestMessage("test-doc", false, 18);
    const msg3 = createTestMessage("test-doc", false, 19);

    sedimentree1.addMessage(msg1);
    sedimentree1.addMessage(msg2, msg1.id);

    sedimentree2.addMessage(msg3, msg2.id);

    sedimentree1.merge(sedimentree2);

    expect(sedimentree1.hasMessage(msg1.id)).toBe(true);
    expect(sedimentree1.hasMessage(msg2.id)).toBe(true);
    expect(sedimentree1.hasMessage(msg3.id)).toBe(true);
    expect(sedimentree1.getStats().totalNodes).toBe(3);
  });

  test("should throw error when merging different documents", () => {
    const sedimentree1 = new Sedimentree("doc1");
    const sedimentree2 = new Sedimentree("doc2");

    expect(() => {
      sedimentree1.merge(sedimentree2);
    }).toThrow("Cannot merge sedimentrees for different documents");
  });

  test("should visualize tree correctly", () => {
    const sedimentree = new Sedimentree("test-doc");

    const msg1 = createTestMessage("test-doc", false, 20);
    const msg2 = createTestMessage("test-doc", false, 21);
    const msg3 = createTestMessage("test-doc", false, 22);

    sedimentree.addMessage(msg1);
    sedimentree.addMessage(msg2, msg1.id);
    sedimentree.addMessage(msg3, msg1.id);

    const visualization = sedimentree.visualize();
    expect(visualization).toContain(msg1.id);
    expect(visualization).toContain(msg2.id);
    expect(visualization).toContain(msg3.id);
    expect(visualization).toContain("├──");
    expect(visualization).toContain("└──");
  });

  test("should handle multiple root nodes", () => {
    const sedimentree = new Sedimentree("test-doc");

    const msg1 = createTestMessage("test-doc", false, 23);
    const msg2 = createTestMessage("test-doc", false, 24);
    const msg3 = createTestMessage("test-doc", false, 25);

    sedimentree.addMessage(msg1);
    sedimentree.addMessage(msg2);
    sedimentree.addMessage(msg3, msg2.id);

    expect(sedimentree.getStats().rootNodes).toBe(2);
    expect(sedimentree.getStats().totalNodes).toBe(3);
  });
});

describe("Sedimentree Compaction", () => {
  test("should compact based on depth strategy", () => {
    const sedimentree = new Sedimentree("test-doc", {
      maxDepth: 3,
      maxChildren: 100,
      maxMessages: 1000,
      enableCompaction: true,
      compactionStrategy: "depth",
    });

    // Create a deep tree that should trigger compaction
    let parentId: string | undefined;
    const messages = [];

    for (let i = 0; i < 10; i++) {
      const msg = createTestMessage("test-doc", false, 30 + i);
      messages.push(msg);
      parentId = sedimentree.addMessage(msg, parentId);
    }

    // Check that compaction occurred
    const stats = sedimentree.getStats();
    expect(stats.compactedNodes).toBeGreaterThan(0);
    expect(stats.maxDepth).toBeLessThanOrEqual(3);

    console.log("Depth-based compaction stats:", stats);
    console.log("Tree visualization after depth compaction:");
    console.log(sedimentree.visualize());
  });

  test("should compact based on children strategy", () => {
    const sedimentree = new Sedimentree("test-doc", {
      maxDepth: 100,
      maxChildren: 2,
      maxMessages: 1000,
      enableCompaction: true,
      compactionStrategy: "children",
    });

    // Create a wide tree that should trigger compaction
    const rootMsg = createTestMessage("test-doc", false, 40);
    sedimentree.addMessage(rootMsg);

    // Add many children to root
    for (let i = 0; i < 10; i++) {
      const msg = createTestMessage("test-doc", false, 41 + i);
      sedimentree.addMessage(msg, rootMsg.id);
    }

    // Check that compaction occurred
    const stats = sedimentree.getStats();
    expect(stats.compactedNodes).toBeGreaterThan(0);

    console.log("Children-based compaction stats:", stats);
    console.log("Tree visualization after children compaction:");
    console.log(sedimentree.visualize());
  });

  test("should compact based on hybrid strategy", () => {
    const sedimentree = new Sedimentree("test-doc", {
      maxDepth: 3,
      maxChildren: 2,
      maxMessages: 1000,
      enableCompaction: true,
      compactionStrategy: "hybrid",
    });

    // Create a tree that triggers both depth and children limits
    let parentId: string | undefined;

    // Create depth
    for (let i = 0; i < 5; i++) {
      const msg = createTestMessage("test-doc", false, 50 + i);
      parentId = sedimentree.addMessage(msg, parentId);
    }

    // Add many children to the last node
    for (let i = 0; i < 5; i++) {
      const msg = createTestMessage("test-doc", false, 55 + i);
      sedimentree.addMessage(msg, parentId);
    }

    // Check that compaction occurred
    const stats = sedimentree.getStats();
    expect(stats.compactedNodes).toBeGreaterThan(0);

    console.log("Hybrid compaction stats:", stats);
    console.log("Tree visualization after hybrid compaction:");
    console.log(sedimentree.visualize());
  });

  test("should not compact when disabled", () => {
    const sedimentree = new Sedimentree("test-doc", {
      maxDepth: 3,
      maxChildren: 2,
      maxMessages: 1000,
      enableCompaction: false,
      compactionStrategy: "hybrid",
    });

    // Create a deep tree
    let parentId: string | undefined;
    for (let i = 0; i < 10; i++) {
      const msg = createTestMessage("test-doc", false, 60 + i);
      parentId = sedimentree.addMessage(msg, parentId);
    }

    // Check that no compaction occurred
    const stats = sedimentree.getStats();
    expect(stats.compactedNodes).toBe(0);
    expect(stats.maxDepth).toBe(9); // 10 nodes = depth 9

    console.log("No compaction stats:", stats);
    console.log("Tree visualization without compaction:");
    console.log(sedimentree.visualize());
  });

  test("should compact subtrees manually", () => {
    const sedimentree = new Sedimentree("test-doc", {
      maxDepth: 100,
      maxChildren: 100,
      maxMessages: 1000,
      enableCompaction: false, // Disable auto-compaction
      compactionStrategy: "hybrid",
    });

    // Create a subtree
    const rootMsg = createTestMessage("test-doc", false, 70);
    sedimentree.addMessage(rootMsg);

    let parentId = rootMsg.id;
    for (let i = 0; i < 5; i++) {
      const msg = createTestMessage("test-doc", false, 71 + i);
      parentId = sedimentree.addMessage(msg, parentId);
    }

    // Manually compact the subtree
    const compactedNode = sedimentree.compactSubtree(rootMsg.id);
    expect(compactedNode).not.toBeNull();
    expect(compactedNode?.compacted).toBe(true);
    expect(compactedNode?.compactedMessages.length).toBeGreaterThan(0);

    const stats = sedimentree.getStats();
    expect(stats.compactedNodes).toBe(1);

    console.log("Manual compaction stats:", stats);
    console.log("Tree visualization after manual compaction:");
    console.log(sedimentree.visualize());
  });

  test("should prune old messages when limit exceeded", () => {
    const sedimentree = new Sedimentree("test-doc", {
      maxDepth: 100,
      maxChildren: 100,
      maxMessages: 5, // Small limit to trigger pruning
      enableCompaction: false,
      compactionStrategy: "hybrid",
    });

    // Add more messages than the limit
    for (let i = 0; i < 10; i++) {
      const msg = createTestMessage("test-doc", false, 80 + i);
      sedimentree.addMessage(msg);
    }

    // Check that pruning occurred
    const stats = sedimentree.getStats();
    expect(stats.totalNodes).toBeLessThanOrEqual(5);

    console.log("Pruning stats:", stats);
    console.log("Tree visualization after pruning:");
    console.log(sedimentree.visualize());
  });
});

describe("Sedimentree Configuration", () => {
  test("should use default configuration", () => {
    const sedimentree = new Sedimentree("test-doc");
    const stats = sedimentree.getStats();

    // Should have default values
    expect(stats.totalNodes).toBe(0);
    expect(stats.rootNodes).toBe(0);
  });

  test("should use custom configuration", () => {
    const sedimentree = new Sedimentree("test-doc", {
      maxDepth: 50,
      maxChildren: 25,
      maxMessages: 5000,
      enableCompaction: false,
      compactionStrategy: "depth",
    });

    // Add a message to trigger configuration validation
    const msg = createTestMessage("test-doc", false, 90);
    sedimentree.addMessage(msg);

    const stats = sedimentree.getStats();
    expect(stats.totalNodes).toBe(1);
  });
});
