import type { Message, ServerContext, BinaryMessage } from "teleportal";
import { decodeMessage } from "teleportal";
import type { ServerSyncTransport } from "./sync-transport";

/**
 * Redis options for server synchronization
 */
export interface RedisSyncOptions {
  /**
   * Redis connection string or options
   */
  connection: string | {
    host?: string;
    port?: number;
    password?: string;
    db?: number;
    [key: string]: any;
  };
  
  /**
   * Optional prefix for Redis keys
   */
  keyPrefix?: string;
  
  /**
   * Optional Redis options
   */
  options?: any;
}

/**
 * Redis-based server synchronization transport.
 * This is dynamically imported to avoid bundling Redis dependencies when not needed.
 */
export class RedisSyncTransport<Context extends ServerContext> implements ServerSyncTransport<Context> {
  private publisherRedis: any;
  private subscriberRedis: any;
  private subscriptions = new Map<string, (message: Message<Context>) => void>();
  private keyPrefix: string;
  private isDestroyed = false;

  constructor(private options: RedisSyncOptions) {
    this.keyPrefix = options.keyPrefix || 'teleportal:sync:';
  }

  /**
   * Initialize Redis connections
   */
  private async initRedis() {
    if (this.publisherRedis && this.subscriberRedis) {
      return;
    }

    // Dynamic import to avoid bundling Redis when not needed
    const { Redis } = await import("ioredis");
    
    const connectionConfig = typeof this.options.connection === 'string' 
      ? this.options.connection 
      : this.options.connection;

    // Create separate connections for publisher and subscriber
    this.publisherRedis = new Redis(connectionConfig, this.options.options);
    this.subscriberRedis = new Redis(connectionConfig, this.options.options);

         // Set up message handler
     this.subscriberRedis.on('messageBuffer', (channel: any, message: any) => {
       try {
         const channelStr = channel.toString();
         const documentId = channelStr.replace(this.keyPrefix, '');
         const handler = this.subscriptions.get(documentId);
         
         if (handler) {
           const decoded = decodeMessage(new Uint8Array(message) as BinaryMessage);
           handler(decoded as Message<Context>);
         }
       } catch (error) {
         console.error('Error handling Redis message:', error);
       }
     });

    this.subscriberRedis.on('error', (error: Error) => {
      console.error('Redis subscriber error:', error);
    });

    this.publisherRedis.on('error', (error: Error) => {
      console.error('Redis publisher error:', error);
    });
  }

  /**
   * Subscribe to updates for a specific document
   */
  async subscribe(documentId: string, onMessage: (message: Message<Context>) => void): Promise<void> {
    if (this.isDestroyed) {
      throw new Error('RedisSyncTransport has been destroyed');
    }

    await this.initRedis();
    
    const channel = this.keyPrefix + documentId;
    this.subscriptions.set(documentId, onMessage);
    
    await this.subscriberRedis.subscribe(channel);
  }

  /**
   * Unsubscribe from updates for a specific document
   */
  async unsubscribe(documentId: string): Promise<void> {
    if (this.isDestroyed) {
      return;
    }

    const channel = this.keyPrefix + documentId;
    this.subscriptions.delete(documentId);
    
    if (this.subscriberRedis) {
      await this.subscriberRedis.unsubscribe(channel);
    }
  }

     /**
    * Publish an update to other server instances for a specific document
    */
   async publish(documentId: string, message: Message<Context>): Promise<void> {
     if (this.isDestroyed) {
       throw new Error('RedisSyncTransport has been destroyed');
     }
 
     await this.initRedis();
     
     const channel = this.keyPrefix + documentId;
     
           // Use the message's encoded property like the existing pubsub transport
      await this.publisherRedis.publish(channel, new Uint8Array(message.encoded));
   }

  /**
   * Close the transport and clean up resources
   */
  async close(): Promise<void> {
    if (this.isDestroyed) {
      return;
    }

    this.isDestroyed = true;
    this.subscriptions.clear();

    if (this.publisherRedis) {
      await this.publisherRedis.quit();
    }

    if (this.subscriberRedis) {
      await this.subscriberRedis.quit();
    }
  }
}