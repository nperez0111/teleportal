import { Observable } from "teleportal";
import { Document } from "teleportal/server";
import {
  PubSubBackend,
  getPubSubTransport,
  InMemoryPubSubBackend,
} from "./index";

/**
 * Example Redis-like backend implementation
 * This is a mock implementation - you would replace this with actual Redis client calls
 */
export class MockRedisBackend implements PubSubBackend {
  private subscribers = new Map<string, Set<(message: Uint8Array) => void>>();

  async publish(topic: string, message: Uint8Array): Promise<void> {
    // In real implementation: await redisClient.publish(topic, Buffer.from(message));
    console.log(`Publishing to Redis topic: ${topic}`);
    const callbacks = this.subscribers.get(topic);
    if (callbacks) {
      for (const callback of callbacks) {
        callback(message);
      }
    }
  }

  async subscribe(
    topic: string,
    callback: (message: Uint8Array) => void,
  ): Promise<() => Promise<void>> {
    // In real implementation: await redisClient.subscribe(topic);
    console.log(`Subscribing to Redis topic: ${topic}`);
    
    if (!this.subscribers.has(topic)) {
      this.subscribers.set(topic, new Set());
    }
    
    const callbacks = this.subscribers.get(topic)!;
    callbacks.add(callback);

    return async () => {
      // In real implementation: await redisClient.unsubscribe(topic);
      console.log(`Unsubscribing from Redis topic: ${topic}`);
      callbacks.delete(callback);
      if (callbacks.size === 0) {
        this.subscribers.delete(topic);
      }
    };
  }

  async close(): Promise<void> {
    // In real implementation: await redisClient.quit();
    console.log("Closing Redis connection");
    this.subscribers.clear();
  }
}

/**
 * Example WebSocket-based backend implementation
 */
export class MockWebSocketBackend implements PubSubBackend {
  private ws: WebSocket | null = null;
  private messageHandlers = new Map<string, (message: Uint8Array) => void>();
  private url: string;

  constructor(url: string) {
    this.url = url;
  }

  private async ensureConnection(): Promise<void> {
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
      this.ws = new WebSocket(this.url);
      
      return new Promise((resolve, reject) => {
        if (!this.ws) return reject(new Error("Failed to create WebSocket"));
        
        this.ws.onopen = () => resolve();
        this.ws.onerror = (error) => reject(error);
        
        this.ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            const handler = this.messageHandlers.get(data.topic);
            if (handler) {
              handler(new Uint8Array(data.message));
            }
          } catch (error) {
            console.error("Error parsing WebSocket message:", error);
          }
        };
      });
    }
  }

  async publish(topic: string, message: Uint8Array): Promise<void> {
    await this.ensureConnection();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: "publish",
        topic,
        message: Array.from(message),
      }));
    }
  }

  async subscribe(
    topic: string,
    callback: (message: Uint8Array) => void,
  ): Promise<() => Promise<void>> {
    await this.ensureConnection();
    
    this.messageHandlers.set(topic, callback);
    
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: "subscribe",
        topic,
      }));
    }

    return async () => {
      this.messageHandlers.delete(topic);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: "unsubscribe",
          topic,
        }));
      }
    };
  }

  async close(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.messageHandlers.clear();
  }
}

/**
 * Example usage with in-memory backend
 */
export function createInMemoryPubSubTransport() {
  const backend = new InMemoryPubSubBackend();
  const observer = new Observable<{
    subscribe: (topic: string) => void;
    unsubscribe: (topic: string) => void;
  }>();

  return getPubSubTransport({
    backend,
    topicResolver: (message) => Document.getDocumentId(message),
    observer,
    onError: (error) => console.error("PubSub Error:", error),
  });
}

/**
 * Example usage with Redis-like backend
 */
export function createRedisPubSubTransport() {
  const backend = new MockRedisBackend();
  const observer = new Observable<{
    subscribe: (topic: string) => void;
    unsubscribe: (topic: string) => void;
  }>();

  return getPubSubTransport({
    backend,
    topicResolver: (message) => `doc:${Document.getDocumentId(message)}`,
    observer,
    onError: (error) => console.error("Redis PubSub Error:", error),
  });
}

/**
 * Example usage with WebSocket backend
 */
export function createWebSocketPubSubTransport(wsUrl: string) {
  const backend = new MockWebSocketBackend(wsUrl);
  const observer = new Observable<{
    subscribe: (topic: string) => void;
    unsubscribe: (topic: string) => void;
  }>();

  return getPubSubTransport({
    backend,
    topicResolver: (message) => `ws:${Document.getDocumentId(message)}`,
    observer,
    onError: (error) => console.error("WebSocket PubSub Error:", error),
  });
}

/**
 * Example of creating a custom backend for any message queue system
 */
export class CustomMessageQueueBackend implements PubSubBackend {
  private messageQueue: any; // Replace with your actual message queue client

  constructor(messageQueueConfig: any) {
    // Initialize your message queue connection
    // this.messageQueue = new YourMessageQueueClient(messageQueueConfig);
  }

  async publish(topic: string, message: Uint8Array): Promise<void> {
    // Implement publishing to your message queue
    // await this.messageQueue.publish(topic, message);
    throw new Error("Implement with your actual message queue");
  }

  async subscribe(
    topic: string,
    callback: (message: Uint8Array) => void,
  ): Promise<() => Promise<void>> {
    // Implement subscription to your message queue
    // const subscription = await this.messageQueue.subscribe(topic, callback);
    // return async () => await subscription.unsubscribe();
    throw new Error("Implement with your actual message queue");
  }

  async close(): Promise<void> {
    // Clean up your message queue connection
    // await this.messageQueue.close();
    throw new Error("Implement with your actual message queue");
  }
}