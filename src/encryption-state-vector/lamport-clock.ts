/**
 * A client id is a unique identifier for a client
 */
export type ClientId = number;
/**
 * A counter is a number that is used to track the number of events that have occurred
 */
export type Counter = number;
/**
 * A Lamport clock id is a unique identifier for a Lamport clock
 */
export type LamportClockId = `${ClientId}-${Counter}`;

/**
 * A Lamport clock value is a tuple of a {@link ClientId} and a {@link Counter}
 */
export type LamportClockValue = [ClientId, Counter];

/**
 * Lamport clock tracks the ordering of events in a distributed system
 * It is a tuple of a {@link ClientId} and a {@link Counter}
 *  - The {@link ClientId} is the id of the client that sent the event
 *  - The {@link Counter} is the number of events that have occurred
 *  - The {@link LamportClockId} is the unique identifier for a Lamport clock ( concatenation of the {@link ClientId} and the {@link Counter})
 */
export class LamportClock {
  constructor(
    private clientId: ClientId,
    private counter: Counter = 0,
  ) {}

  /**
   * Local event (increment {@link Counter})
   */
  tick(): LamportClockValue {
    this.counter += 1;
    return [this.clientId, this.counter];
  }

  /**
   * Send event (increment and return {@link ClientId} and {@link Counter})
   */
  send(): LamportClockValue {
    return this.tick();
  }

  /**
   * Receive event (update {@link Counter} to max and increment)
   */
  receive(receivedTimestamp: LamportClockValue): LamportClockValue {
    this.counter = Math.max(this.counter, receivedTimestamp[1]) + 1;
    return [this.clientId, this.counter];
  }

  /**
   * Get current {@link ClientId} and {@link Counter}
   */
  getTimestamp(): LamportClockValue {
    return [this.clientId, this.counter];
  }

  /**
   * Convert a {@link ClientId} and {@link Counter} to a {@link LamportClockId}
   */
  public static toLamportClockId(
    clientId: ClientId,
    counter: Counter,
  ): LamportClockId {
    return `${clientId}-${counter}`;
  }

  /**
   * Convert a {@link LamportClockId} to a {@link ClientId} and {@link Counter}
   */
  public static fromLamportClockId(
    lamportClockId: LamportClockId,
  ): LamportClockValue {
    const [clientId, counter] = lamportClockId.split("-");
    return [parseInt(clientId), parseInt(counter)];
  }
}
