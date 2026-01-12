import type { Message } from "teleportal";
import type { Connection } from "../connection.js";
import type {
  DevtoolOptions,
  MessageDirection,
  MessageEntry,
} from "./types.js";
import { calculateMessageSize } from "./utils.js";

/**
 * Tracks all messages sent and received by a Provider
 */
export class MessageTracker {
  private messages: MessageEntry[] = [];
  private maxMessages: number;
  private onMessageCallback?: (entry: MessageEntry) => void;

  constructor(options: DevtoolOptions = {}) {
    this.maxMessages = options.maxMessages ?? 200;
  }

  /**
   * Set callback for when a new message is tracked
   */
  setOnMessage(callback: (entry: MessageEntry) => void): void {
    this.onMessageCallback = callback;
  }

  /**
   * Track a sent message
   */
  trackSent(message: Message): void {
    this.trackMessage(message, "sent");
  }

  /**
   * Track a received message
   */
  trackReceived(message: Message): void {
    this.trackMessage(message, "received");
  }

  /**
   * Track a message
   */
  private trackMessage(message: Message, direction: MessageDirection): void {
    const entry: MessageEntry = {
      id: message.id,
      direction,
      message,
      timestamp: Date.now(),
      documentId: message.document,
      size: calculateMessageSize(message),
    };

    // Add to beginning of array (most recent first)
    this.messages.unshift(entry);

    // Remove oldest messages if we exceed the limit
    if (this.messages.length > this.maxMessages) {
      this.messages = this.messages.slice(0, this.maxMessages);
    }

    // Notify callback
    if (this.onMessageCallback) {
      this.onMessageCallback(entry);
    }
  }

  /**
   * Get all tracked messages
   */
  getMessages(): MessageEntry[] {
    return [...this.messages];
  }

  /**
   * Get a message by ID
   */
  getMessage(id: string): MessageEntry | undefined {
    return this.messages.find((m) => m.id === id);
  }

  /**
   * Clear all messages
   */
  clear(): void {
    this.messages = [];
  }

  /**
   * Get statistics
   */
  getStats(): {
    total: number;
    sent: number;
    received: number;
    bytesSent: number;
    bytesReceived: number;
  } {
    let sent = 0;
    let received = 0;
    let bytesSent = 0;
    let bytesReceived = 0;

    for (const entry of this.messages) {
      if (entry.direction === "sent") {
        sent++;
        bytesSent += entry.size;
      } else {
        received++;
        bytesReceived += entry.size;
      }
    }

    return {
      total: this.messages.length,
      sent,
      received,
      bytesSent,
      bytesReceived,
    };
  }

  /**
   * Hook into a Connection to track messages
   * This wraps the connection's send method and message events
   */
  hookConnection(connection: Connection<any>): () => void {
    // Track received messages
    const unsubscribeMessage = connection.on("message", (message: Message) => {
      this.trackReceived(message);
    });

    // Track sent messages by wrapping the send method
    const originalSend = connection.send.bind(connection);
    connection.send = async (message: Message) => {
      this.trackSent(message);
      return originalSend(message);
    };

    // Return cleanup function
    return () => {
      unsubscribeMessage();
      connection.send = originalSend;
    };
  }

  /**
   * Hook into Provider's transport streams
   * This creates wrapped streams that intercept messages
   * 
   * Note: transport.readable = messages TO SEND (outgoing)
   *       transport.writable = receives messages FROM connection (incoming)
   */
  hookTransportStreams(
    transport: {
      readable: ReadableStream<Message>;
      writable: WritableStream<Message>;
    },
  ): {
    readable: ReadableStream<Message>;
    writable: WritableStream<Message>;
    cleanup: () => void;
  } {
    const tracker = this; // Capture this for use in closures

    // Wrap readable stream to track SENT messages (outgoing)
    const originalReadable = transport.readable;
    const wrappedReadable = new ReadableStream<Message>({
      async start(controller) {
        const reader = originalReadable.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
              break;
            }
            // Track sent message (outgoing)
            tracker.trackSent(value);
            controller.enqueue(value);
          }
        } catch (error) {
          controller.error(error);
        } finally {
          reader.releaseLock();
        }
      },
    });

    // Wrap writable stream to track RECEIVED messages (incoming)
    const originalWritable = transport.writable;
    const wrappedWritable = new WritableStream<Message>({
      async write(chunk) {
        // Track received message (incoming from connection)
        tracker.trackReceived(chunk);
        const writer = originalWritable.getWriter();
        try {
          await writer.write(chunk);
        } finally {
          writer.releaseLock();
        }
      },
    });

    return {
      readable: wrappedReadable,
      writable: wrappedWritable,
      cleanup: () => {
        // Cleanup if needed
      },
    };
  }
}
