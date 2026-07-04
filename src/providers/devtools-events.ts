/**
 * The envelope delivered to {@link DevtoolsEventClient} listeners. Matches the
 * shape `@tanstack/devtools-event-client` delivered so consumers (the devtools
 * `EventManager`) read `event.payload` unchanged.
 */
export type DevtoolsEvent<EventMap extends Record<string, unknown>, K extends keyof EventMap> = {
  type: K;
  payload: EventMap[K];
  pluginId: string;
};

/**
 * Minimal in-memory pub/sub for devtools observation events.
 *
 * This replaces `@tanstack/devtools-event-client` on purpose: that client
 * forwards every emitted event onto the TanStack devtools window bus, whose
 * dispatcher JSON-stringifies the full payload twice (once for its WebSocket
 * to the devtools server, once for a BroadcastChannel) whenever a TanStack
 * devtools shell is mounted — even with the panel closed. Provider events
 * carry live `Provider`/`Connection` references and megabyte binary chunks;
 * stringifying those on the receive path cost ~350ms per 1MB file part. The
 * teleportal devtools panel lives in the same JS context and only ever
 * consumed the in-memory delivery, so events stay plain object references
 * here and are never serialized. Anything payload-heavy is only inspected
 * (stringified) lazily by the panel when the user opens a message.
 */
export class DevtoolsEventClient<EventMap extends Record<string, unknown>> {
  #pluginId: string;
  #listeners = new Map<keyof EventMap, Set<(event: DevtoolsEvent<EventMap, any>) => void>>();

  constructor(pluginId: string) {
    this.#pluginId = pluginId;
  }

  emit<K extends keyof EventMap>(type: K, payload: EventMap[K]): void {
    const listeners = this.#listeners.get(type);
    if (!listeners || listeners.size === 0) {
      return;
    }
    const event: DevtoolsEvent<EventMap, K> = { type, payload, pluginId: this.#pluginId };
    // Set iteration tolerates deletes, so listeners may unsubscribe mid-delivery.
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // Observers must never break the message pipeline they observe.
      }
    }
  }

  on<K extends keyof EventMap>(
    type: K,
    listener: (event: DevtoolsEvent<EventMap, K>) => void,
  ): () => void {
    let listeners = this.#listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(type, listeners);
    }
    listeners.add(listener as (event: DevtoolsEvent<EventMap, any>) => void);
    return () => {
      listeners.delete(listener as (event: DevtoolsEvent<EventMap, any>) => void);
    };
  }
}
