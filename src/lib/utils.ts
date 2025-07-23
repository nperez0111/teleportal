import { createHooks } from "hookable";
import { BinaryMessage, PubSub, PubSubTopic } from "teleportal";

export class Observable<
  EVENTS extends Record<string, (...args: any[]) => void>,
> {
  #hooks = createHooks<EVENTS>();

  /**
   * Listen for a named event.
   */
  on = this.#hooks.hook.bind(this.#hooks);

  /**
   * Listen for a named event once.
   */
  once = this.#hooks.hookOnce.bind(this.#hooks);

  /**
   * Remove a listener for a named event.
   */
  off = this.#hooks.removeHook.bind(this.#hooks);

  /**
   * Call a named event in serial.
   *
   * @note This is useful for events that need to be called in order.
   */
  callSerial = this.#hooks.callHook.bind(this.#hooks);

  /**
   * Call a named event in parallel.
   *
   * @note This is useful for general broadcast events.
   */
  call = this.#hooks.callHookParallel.bind(this.#hooks);

  /**
   * Remove all listeners for all events.
   */
  destroy() {
    this.#hooks.removeAllHooks();
  }

  /**
   * Add a listener for a named event.
   */
  addListeners = this.#hooks.addHooks.bind(this.#hooks);
}

/**
 * Simple in-memory pub/sub backend implementation for testing/development
 */
export class InMemoryPubSub
  extends Observable<{
    [key: PubSubTopic]: (message: BinaryMessage) => void;
  }>
  implements PubSub
{
  async publish(topic: PubSubTopic, message: BinaryMessage): Promise<void> {
    await this.call(topic, message);
  }

  async subscribe(
    topic: PubSubTopic,
    callback: (message: BinaryMessage) => void,
  ): Promise<() => Promise<void>> {
    const unsubscribe = this.on(topic, callback);

    return async () => {
      unsubscribe();
    };
  }

  async destroy(): Promise<void> {
    super.destroy();
  }
}
