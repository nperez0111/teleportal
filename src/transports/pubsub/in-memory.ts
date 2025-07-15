import { PubSubBackend } from ".";
import { BinaryMessage } from "teleportal";

/**
 * Simple in-memory pub/sub backend implementation for testing/development
 */
export class InMemoryPubSubBackend implements PubSubBackend {
  private subscribers = new Map<
    string,
    Set<(message: BinaryMessage) => void>
  >();

  async publish(topic: string, message: BinaryMessage): Promise<void> {
    const callbacks = this.subscribers.get(topic);
    if (callbacks) {
      for (const callback of callbacks) {
        callback(message);
      }
    }
  }

  async subscribe(
    topic: string,
    callback: (message: BinaryMessage) => void,
  ): Promise<() => Promise<void>> {
    if (!this.subscribers.has(topic)) {
      this.subscribers.set(topic, new Set());
    }

    const callbacks = this.subscribers.get(topic)!;
    callbacks.add(callback);

    // Return unsubscribe function
    return async () => {
      callbacks.delete(callback);
      if (callbacks.size === 0) {
        this.subscribers.delete(topic);
      }
    };
  }

  async close(): Promise<void> {
    this.subscribers.clear();
  }
}
