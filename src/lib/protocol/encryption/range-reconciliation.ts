import type { ClientId, Counter, LamportClockValue } from "./lamport-clock";
import type { EncryptedMessageId } from "./encoding";
import type { SeenMessageMapping } from "./sync";

/**
 * Represents a range of consecutive counters for a client
 */
export interface CounterRange {
  /**
   * The start of the range (inclusive)
   */
  start: Counter;
  /**
   * The end of the range (inclusive)
   */
  end: Counter;
}

/**
 * Represents seen messages as ranges of counters per client
 * This is more efficient than storing individual counter->messageId mappings
 * when there are many consecutive messages
 */
export type RangeBasedSeenMessages = Record<
  ClientId,
  {
    ranges: CounterRange[];
    messageIds: Map<Counter, EncryptedMessageId>;
  }
>;

/**
 * Converts a SeenMessageMapping to a RangeBasedSeenMessages format
 * by identifying consecutive counter ranges
 */
export function toRangeBased(
  seenMessages: SeenMessageMapping,
): RangeBasedSeenMessages {
  const result: RangeBasedSeenMessages = {};

  for (const [clientIdStr, counterMap] of Object.entries(seenMessages)) {
    const clientId = parseInt(clientIdStr);
    const counters = Object.keys(counterMap)
      .map((c) => parseInt(c))
      .sort((a, b) => a - b);

    if (counters.length === 0) {
      continue;
    }

    const ranges: CounterRange[] = [];
    const messageIds = new Map<Counter, EncryptedMessageId>();

    // Build ranges from consecutive counters
    let rangeStart = counters[0];
    let rangeEnd = counters[0];

    for (let i = 1; i < counters.length; i++) {
      const currentCounter = counters[i];
      const previousCounter = counters[i - 1];

      if (currentCounter === previousCounter + 1) {
        // Consecutive, extend the range
        rangeEnd = currentCounter;
      } else {
        // Gap found, save current range and start a new one
        ranges.push({ start: rangeStart, end: rangeEnd });
        rangeStart = currentCounter;
        rangeEnd = currentCounter;
      }
    }

    // Add the last range
    ranges.push({ start: rangeStart, end: rangeEnd });

    // Store message IDs for all counters
    for (const counter of counters) {
      const messageId = counterMap[counter];
      if (messageId) {
        messageIds.set(counter, messageId);
      }
    }

    result[clientId] = { ranges, messageIds };
  }

  return result;
}

/**
 * Converts RangeBasedSeenMessages back to SeenMessageMapping format
 */
export function fromRangeBased(
  rangeBased: RangeBasedSeenMessages,
): SeenMessageMapping {
  const result: SeenMessageMapping = {};

  for (const [clientIdStr, data] of Object.entries(rangeBased)) {
    const clientId = parseInt(clientIdStr);
    const counterMap: Record<Counter, EncryptedMessageId> = {};

    // Reconstruct from ranges and messageIds
    for (const range of data.ranges) {
      for (let counter = range.start; counter <= range.end; counter++) {
        const messageId = data.messageIds.get(counter);
        if (messageId) {
          counterMap[counter] = messageId;
        }
      }
    }

    if (Object.keys(counterMap).length > 0) {
      result[clientId] = counterMap;
    }
  }

  return result;
}

/**
 * Computes the set difference between two range-based seen message sets
 * Returns the counters (and their message IDs) that are in `local` but not in `remote`
 */
export function computeSetDifference(
  local: RangeBasedSeenMessages,
  remote: RangeBasedSeenMessages,
): Map<ClientId, Map<Counter, EncryptedMessageId>> {
  const result = new Map<ClientId, Map<Counter, EncryptedMessageId>>();

  // For each client in local
  for (const [clientIdStr, localData] of Object.entries(local)) {
    const clientId = parseInt(clientIdStr);
    const remoteData = remote[clientId];

    // If remote doesn't have this client, all local messages are needed
    if (!remoteData) {
      const messageMap = new Map<Counter, EncryptedMessageId>();
      for (const range of localData.ranges) {
        for (let counter = range.start; counter <= range.end; counter++) {
          const messageId = localData.messageIds.get(counter);
          if (messageId) {
            messageMap.set(counter, messageId);
          }
        }
      }
      if (messageMap.size > 0) {
        result.set(clientId, messageMap);
      }
      continue;
    }

    // Compute difference for this client
    const messageMap = new Map<Counter, EncryptedMessageId>();

    // Get all remote counters as a set for fast lookup
    const remoteCounters = new Set<Counter>();
    for (const range of remoteData.ranges) {
      for (let counter = range.start; counter <= range.end; counter++) {
        remoteCounters.add(counter);
      }
    }

    // Find counters in local that are not in remote
    for (const range of localData.ranges) {
      for (let counter = range.start; counter <= range.end; counter++) {
        if (!remoteCounters.has(counter)) {
          const messageId = localData.messageIds.get(counter);
          if (messageId) {
            messageMap.set(counter, messageId);
          }
        }
      }
    }

    if (messageMap.size > 0) {
      result.set(clientId, messageMap);
    }
  }

  return result;
}

/**
 * Computes the set difference using a state vector (which represents the highest counter per client)
 * This is more efficient than full range-based reconciliation when we only have state vectors
 */
export function computeSetDifferenceFromStateVector(
  local: RangeBasedSeenMessages,
  remoteStateVector: Map<ClientId, Counter>,
): Map<ClientId, Map<Counter, EncryptedMessageId>> {
  const result = new Map<ClientId, Map<Counter, EncryptedMessageId>>();

  for (const [clientIdStr, localData] of Object.entries(local)) {
    const clientId = parseInt(clientIdStr);
    const remoteMaxCounter = remoteStateVector.get(clientId) ?? -1;

    const messageMap = new Map<Counter, EncryptedMessageId>();

    // Find all counters in local that are greater than remote's max counter
    for (const range of localData.ranges) {
      // Only process ranges that extend beyond remote's max counter
      if (range.end > remoteMaxCounter) {
        const startCounter = Math.max(range.start, remoteMaxCounter + 1);
        for (let counter = startCounter; counter <= range.end; counter++) {
          const messageId = localData.messageIds.get(counter);
          if (messageId) {
            messageMap.set(counter, messageId);
          }
        }
      }
    }

    if (messageMap.size > 0) {
      result.set(clientId, messageMap);
    }
  }

  return result;
}

/**
 * Merges two range-based seen message sets
 * Used when receiving updates from another client
 */
export function mergeRangeBased(
  local: RangeBasedSeenMessages,
  incoming: Map<ClientId, Map<Counter, EncryptedMessageId>>,
): RangeBasedSeenMessages {
  const result: RangeBasedSeenMessages = { ...local };

  for (const [clientId, messageMap] of incoming.entries()) {
    if (!result[clientId]) {
      result[clientId] = { ranges: [], messageIds: new Map() };
    }

    // Add new message IDs
    for (const [counter, messageId] of messageMap.entries()) {
      result[clientId].messageIds.set(counter, messageId);
    }

    // Rebuild ranges for this client
    const counters = Array.from(result[clientId].messageIds.keys()).sort(
      (a, b) => a - b,
    );

    if (counters.length === 0) {
      continue;
    }

    const ranges: CounterRange[] = [];
    let rangeStart = counters[0];
    let rangeEnd = counters[0];

    for (let i = 1; i < counters.length; i++) {
      const currentCounter = counters[i];
      const previousCounter = counters[i - 1];

      if (currentCounter === previousCounter + 1) {
        rangeEnd = currentCounter;
      } else {
        ranges.push({ start: rangeStart, end: rangeEnd });
        rangeStart = currentCounter;
        rangeEnd = currentCounter;
      }
    }

    ranges.push({ start: rangeStart, end: rangeEnd });
    result[clientId].ranges = ranges;
  }

  return result;
}
