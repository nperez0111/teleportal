import { toBase64 } from "lib0/buffer";
import type { Message } from "teleportal/protocol";

/**
 * Represents a message identifier in the sedimentree
 */
export type SedimentreeMessageId = string;

/**
 * Represents a node in the sedimentree
 */
export interface SedimentreeNode {
  /** Unique identifier for this node */
  id: SedimentreeMessageId;
  /** Timestamp when this node was created */
  timestamp: number;
  /** Parent node ID, null for root nodes */
  parentId: SedimentreeMessageId | null;
  /** Array of child node IDs */
  children: SedimentreeMessageId[];
  /** Depth of this node in the tree */
  depth: number;
  /** Whether this node has been compacted */
  compacted: boolean;
  /** Metadata associated with this node */
  metadata?: Record<string, unknown>;
}

/**
 * Represents a compacted node that contains multiple messages
 */
export interface CompactedNode extends SedimentreeNode {
  /** Array of message IDs that have been compacted into this node */
  compactedMessages: SedimentreeMessageId[];
  /** The root message ID of the compacted subtree */
  rootMessageId: SedimentreeMessageId;
}

/**
 * Configuration options for the sedimentree
 */
export interface SedimentreeConfig {
  /** Maximum depth before compaction is triggered */
  maxDepth: number;
  /** Maximum number of children before compaction is triggered */
  maxChildren: number;
  /** Maximum number of messages to keep in memory */
  maxMessages: number;
  /** Whether to enable automatic compaction */
  enableCompaction: boolean;
  /** Compaction strategy to use */
  compactionStrategy: "depth" | "children" | "hybrid";
}

/**
 * Default configuration for the sedimentree
 */
const DEFAULT_CONFIG: SedimentreeConfig = {
  maxDepth: 100,
  maxChildren: 50,
  maxMessages: 10000,
  enableCompaction: true,
  compactionStrategy: "hybrid",
};

/**
 * Sedimentree - A tree-based data structure for efficient message history tracking
 *
 * The sedimentree maintains a tree structure of messages where each message
 * becomes a node in the tree. The tree grows over time as new messages are added,
 * and old branches can be compacted to maintain performance.
 *
 * Key features:
 * - Tree-based message history with parent-child relationships
 * - Automatic compaction to prevent unbounded growth
 * - Efficient querying of message ancestry and descendants
 * - Support for multiple compaction strategies
 * - Serialization for persistence
 */
export class Sedimentree {
  private nodes: Map<SedimentreeMessageId, SedimentreeNode> = new Map();
  private rootNodes: Set<SedimentreeMessageId> = new Set();
  private config: SedimentreeConfig;
  private document: string;

  constructor(document: string, config: Partial<SedimentreeConfig> = {}) {
    this.document = document;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Add a message to the sedimentree
   */
  addMessage(
    message: Message<any>,
    parentId?: SedimentreeMessageId,
  ): SedimentreeMessageId {
    if (message.document !== this.document) {
      throw new Error(
        `Message document ${message.document} does not match sedimentree document ${this.document}`,
      );
    }

    const messageId = message.id;
    const timestamp = Date.now();

    // Create the node
    const node: SedimentreeNode = {
      id: messageId,
      timestamp,
      parentId: parentId || null,
      children: [],
      depth: parentId ? (this.nodes.get(parentId)?.depth || 0) + 1 : 0,
      compacted: false,
      metadata: {
        messageType: message.type,
        encrypted: message.encrypted,
      },
    };

    // Add to the tree
    this.nodes.set(messageId, node);

    // Update parent's children list
    if (parentId) {
      const parent = this.nodes.get(parentId);
      if (parent) {
        parent.children.push(messageId);
      }
    } else {
      this.rootNodes.add(messageId);
    }

    // Check if compaction is needed
    if (this.config.enableCompaction) {
      this.checkAndCompact();
    }

    // Prune if we have too many messages
    this.prune();

    return messageId;
  }

  /**
   * Get a node by its ID
   */
  getNode(messageId: SedimentreeMessageId): SedimentreeNode | undefined {
    return this.nodes.get(messageId);
  }

  /**
   * Check if a message exists in the tree
   */
  hasMessage(messageId: SedimentreeMessageId): boolean {
    return this.nodes.has(messageId);
  }

  /**
   * Get all message IDs in the tree
   */
  getAllMessageIds(): SedimentreeMessageId[] {
    return Array.from(this.nodes.keys());
  }

  /**
   * Get the ancestry chain for a message (path from root to message)
   */
  getAncestry(messageId: SedimentreeMessageId): SedimentreeMessageId[] {
    const ancestry: SedimentreeMessageId[] = [];
    let currentId: SedimentreeMessageId | null = messageId;

    while (currentId) {
      const node = this.nodes.get(currentId);
      if (!node) break;

      ancestry.unshift(currentId);
      currentId = node.parentId;
    }

    return ancestry;
  }

  /**
   * Get all descendants of a message (recursive)
   */
  getDescendants(messageId: SedimentreeMessageId): SedimentreeMessageId[] {
    const descendants: SedimentreeMessageId[] = [];
    const node = this.nodes.get(messageId);

    if (!node) return descendants;

    const traverse = (nodeId: SedimentreeMessageId) => {
      const currentNode = this.nodes.get(nodeId);
      if (!currentNode) return;

      descendants.push(nodeId);
      for (const childId of currentNode.children) {
        traverse(childId);
      }
    };

    // Start traversal from children (exclude the root message)
    for (const childId of node.children) {
      traverse(childId);
    }

    return descendants;
  }

  /**
   * Get the subtree rooted at a specific message
   */
  getSubtree(messageId: SedimentreeMessageId): SedimentreeNode[] {
    const subtree: SedimentreeNode[] = [];
    const node = this.nodes.get(messageId);

    if (!node) return subtree;

    const traverse = (nodeId: SedimentreeMessageId) => {
      const currentNode = this.nodes.get(nodeId);
      if (!currentNode) return;

      subtree.push(currentNode);
      for (const childId of currentNode.children) {
        traverse(childId);
      }
    };

    traverse(messageId);
    return subtree;
  }

  /**
   * Get messages that are newer than a given message
   */
  getMessagesSince(messageId: SedimentreeMessageId): SedimentreeMessageId[] {
    const descendants = this.getDescendants(messageId);
    return descendants.sort((a, b) => {
      const nodeA = this.nodes.get(a);
      const nodeB = this.nodes.get(b);
      return (nodeA?.timestamp || 0) - (nodeB?.timestamp || 0);
    });
  }

  /**
   * Get the latest message in the tree
   */
  getLatestMessage(): SedimentreeMessageId | null {
    let latest: SedimentreeMessageId | null = null;
    let latestTimestamp = 0;

    for (const [messageId, node] of this.nodes) {
      if (node.timestamp > latestTimestamp) {
        latestTimestamp = node.timestamp;
        latest = messageId;
      }
    }

    return latest;
  }

  /**
   * Compact a subtree to reduce tree depth
   */
  compactSubtree(rootId: SedimentreeMessageId): CompactedNode | null {
    const root = this.nodes.get(rootId);
    if (!root || root.compacted) return null;

    const descendants = this.getDescendants(rootId);
    if (descendants.length === 0) return null;

    // Create a compacted node
    const compactedNode: CompactedNode = {
      ...root,
      compacted: true,
      compactedMessages: descendants,
      rootMessageId: rootId,
      children: [], // Clear children since they're now compacted
    };

    // Update the root node
    this.nodes.set(rootId, compactedNode);

    // Remove all descendant nodes
    for (const descendantId of descendants) {
      this.nodes.delete(descendantId);
    }

    return compactedNode;
  }

  /**
   * Check if compaction is needed and perform it
   */
  private checkAndCompact(): void {
    const nodesToCompact: SedimentreeMessageId[] = [];

    for (const [messageId, node] of this.nodes) {
      if (node.compacted) continue;

      let shouldCompact = false;

      switch (this.config.compactionStrategy) {
        case "depth":
          shouldCompact = node.depth >= this.config.maxDepth;
          break;
        case "children":
          shouldCompact = node.children.length >= this.config.maxChildren;
          break;
        case "hybrid":
          shouldCompact =
            node.depth >= this.config.maxDepth ||
            node.children.length >= this.config.maxChildren;
          break;
      }

      if (shouldCompact) {
        nodesToCompact.push(messageId);
      }
    }

    // Compact nodes from deepest to shallowest to avoid conflicts
    nodesToCompact
      .sort((a, b) => {
        const nodeA = this.nodes.get(a);
        const nodeB = this.nodes.get(b);
        return (nodeB?.depth || 0) - (nodeA?.depth || 0);
      })
      .forEach((messageId) => {
        this.compactSubtree(messageId);
      });
  }

  /**
   * Prune old messages to maintain memory limits
   */
  private prune(): void {
    if (this.nodes.size <= this.config.maxMessages) return;

    // Get all nodes sorted by timestamp (oldest first)
    const sortedNodes = Array.from(this.nodes.entries()).sort(
      ([, a], [, b]) => a.timestamp - b.timestamp,
    );

    const nodesToRemove = sortedNodes.slice(
      0,
      this.nodes.size - this.config.maxMessages,
    );

    for (const [messageId] of nodesToRemove) {
      this.removeNode(messageId);
    }
  }

  /**
   * Remove a node and its descendants from the tree
   */
  private removeNode(messageId: SedimentreeMessageId): void {
    const node = this.nodes.get(messageId);
    if (!node) return;

    // Remove from parent's children list
    if (node.parentId) {
      const parent = this.nodes.get(node.parentId);
      if (parent) {
        parent.children = parent.children.filter((id) => id !== messageId);
      }
    } else {
      this.rootNodes.delete(messageId);
    }

    // Remove the node and all its descendants
    const descendants = this.getDescendants(messageId);
    for (const descendantId of descendants) {
      this.nodes.delete(descendantId);
    }
    this.nodes.delete(messageId);
  }

  /**
   * Get statistics about the tree
   */
  getStats(): {
    totalNodes: number;
    rootNodes: number;
    maxDepth: number;
    averageDepth: number;
    compactedNodes: number;
  } {
    let maxDepth = 0;
    let totalDepth = 0;
    let compactedNodes = 0;

    for (const node of this.nodes.values()) {
      maxDepth = Math.max(maxDepth, node.depth);
      totalDepth += node.depth;
      if (node.compacted) compactedNodes++;
    }

    return {
      totalNodes: this.nodes.size,
      rootNodes: this.rootNodes.size,
      maxDepth,
      averageDepth: this.nodes.size > 0 ? totalDepth / this.nodes.size : 0,
      compactedNodes,
    };
  }

  /**
   * Serialize the sedimentree to a string
   */
  serialize(): string {
    const data = {
      document: this.document,
      config: this.config,
      nodes: Object.fromEntries(this.nodes),
      rootNodes: Array.from(this.rootNodes),
    };
    return toBase64(new TextEncoder().encode(JSON.stringify(data)));
  }

  /**
   * Deserialize a sedimentree from a string
   */
  static deserialize(serialized: string): Sedimentree {
    const data = JSON.parse(
      new TextDecoder().decode(
        new Uint8Array(Array.from(atob(serialized), (c) => c.charCodeAt(0))),
      ),
    );

    const sedimentree = new Sedimentree(data.document, data.config);
    sedimentree.nodes = new Map(Object.entries(data.nodes));
    sedimentree.rootNodes = new Set(data.rootNodes);

    return sedimentree;
  }

  /**
   * Merge another sedimentree into this one
   */
  merge(other: Sedimentree): void {
    if (other.document !== this.document) {
      throw new Error(`Cannot merge sedimentrees for different documents`);
    }

    for (const [messageId, node] of other.nodes) {
      if (!this.nodes.has(messageId)) {
        this.nodes.set(messageId, node);

        if (!node.parentId) {
          this.rootNodes.add(messageId);
        }
      }
    }
  }

  /**
   * Get a visual representation of the tree structure
   */
  visualize(): string {
    const lines: string[] = [];

    const traverse = (
      nodeId: SedimentreeMessageId,
      prefix: string,
      isLast: boolean,
    ) => {
      const node = this.nodes.get(nodeId);
      if (!node) return;

      const connector = isLast ? "└── " : "├── ";
      const compacted = node.compacted ? " [C]" : "";
      lines.push(`${prefix}${connector}${nodeId}${compacted}`);

      const newPrefix = prefix + (isLast ? "    " : "│   ");
      for (let i = 0; i < node.children.length; i++) {
        const childId = node.children[i];
        const isLastChild = i === node.children.length - 1;
        traverse(childId, newPrefix, isLastChild);
      }
    };

    // Start from root nodes
    const rootArray = Array.from(this.rootNodes);
    for (let i = 0; i < rootArray.length; i++) {
      const rootId = rootArray[i];
      const isLast = i === rootArray.length - 1;
      traverse(rootId, "", isLast);
    }

    return lines.join("\n");
  }
}
