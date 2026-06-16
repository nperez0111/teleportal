import type {
  StateVector,
  Update,
  UpdateV1,
  UpdateV2,
  VersionedUpdate,
  VersionedSyncStep2Update,
} from "teleportal/protocol";
import * as Y from "yjs";

export const getEmptyUpdate = (): Update =>
  new Uint8Array([0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]) as Update;

export const getEmptyVersionedUpdate = (): VersionedUpdate => ({
  version: 2,
  data: getEmptyUpdate(),
});

export const getEmptyStateVector = (): StateVector => new Uint8Array([0]) as StateVector;

export function isEmptyUpdate(update: Uint8Array): boolean {
  return (
    update[0] === 0 &&
    update[1] === 0 &&
    update[2] === 0 &&
    update[3] === 0 &&
    update[4] === 0 &&
    update[5] === 0 &&
    update[6] === 1 &&
    update[7] === 0 &&
    update[8] === 0 &&
    update[9] === 0 &&
    update[10] === 0 &&
    update[11] === 0 &&
    update[12] === 0 &&
    update.length === 13
  );
}

export function isEmptyVersionedUpdate(update: VersionedUpdate): boolean {
  return isEmptyUpdate(update.data);
}

export function isEmptySyncStep2(syncStep2: VersionedSyncStep2Update): boolean {
  return isEmptyUpdate(syncStep2.data);
}

export function isEmptyStateVector(stateVector: StateVector): boolean {
  return stateVector[0] === 0 && stateVector.length === 1;
}

export function convertToV2(update: VersionedUpdate): UpdateV2 {
  if (update.version === 2) return update.data;
  return Y.convertUpdateFormatV1ToV2(update.data) as UpdateV2;
}

export function convertSyncStep2ToV2(update: VersionedSyncStep2Update): UpdateV2 {
  if (update.version === 2) return update.data as unknown as UpdateV2;
  return Y.convertUpdateFormatV1ToV2(update.data) as UpdateV2;
}

export function applyVersionedUpdate(doc: Y.Doc, update: VersionedUpdate, origin?: any): void {
  if (update.version === 1) {
    Y.applyUpdate(doc, update.data, origin);
  } else {
    Y.applyUpdateV2(doc, update.data, origin);
  }
}

export function applyVersionedSyncStep2(
  doc: Y.Doc,
  update: VersionedSyncStep2Update,
  origin?: any,
): void {
  if (update.version === 1) {
    Y.applyUpdate(doc, update.data, origin);
  } else {
    Y.applyUpdateV2(doc, update.data, origin);
  }
}

export function getStateVectorFromUpdate(update: UpdateV2 | UpdateV2[]): StateVector {
  if (Array.isArray(update)) {
    return Y.encodeStateVectorFromUpdateV2(Y.mergeUpdatesV2(update)) as StateVector;
  }
  return Y.encodeStateVectorFromUpdateV2(update) as StateVector;
}

export function getUpdateFromDoc(doc: Y.Doc): UpdateV2 {
  return Y.encodeStateAsUpdateV2(doc) as UpdateV2;
}

export function mergeUpdates(updates: UpdateV2[]): UpdateV2 {
  return Y.mergeUpdatesV2(updates) as UpdateV2;
}

export function mergeUpdatesV1(updates: UpdateV1[]): UpdateV1 {
  return Y.mergeUpdates(updates) as UpdateV1;
}

export function mergeVersionedUpdates(updates: VersionedUpdate[]): VersionedUpdate {
  if (updates.length === 0) return getEmptyVersionedUpdate();
  const version = updates[0].version;
  if (version === 1) {
    return {
      version: 1,
      data: mergeUpdatesV1(updates.map((u) => u.data as UpdateV1)),
    };
  }
  return {
    version: 2,
    data: mergeUpdates(updates.map((u) => u.data as UpdateV2)),
  };
}

export function decodeUpdateVersioned(
  update: VersionedUpdate,
): ReturnType<typeof Y.decodeUpdateV2> {
  if (update.version === 1) {
    return Y.decodeUpdate(update.data);
  }
  return Y.decodeUpdateV2(update.data);
}

export function parseUpdateMetaVersioned(
  update: VersionedUpdate,
): ReturnType<typeof Y.parseUpdateMetaV2> {
  if (update.version === 1) {
    return Y.parseUpdateMeta(update.data);
  }
  return Y.parseUpdateMetaV2(update.data);
}

export function encodeStateVectorFromVersionedUpdate(update: VersionedUpdate): StateVector {
  if (update.version === 1) {
    return Y.encodeStateVectorFromUpdate(update.data) as StateVector;
  }
  return Y.encodeStateVectorFromUpdateV2(update.data) as StateVector;
}

export function encodeVersionedBytes(update: VersionedUpdate): Uint8Array {
  const out = new Uint8Array(1 + update.data.length);
  out[0] = update.version;
  out.set(update.data, 1);
  return out;
}

export function decodeVersionedBytes(bytes: Uint8Array): VersionedUpdate {
  const version = bytes[0] as 1 | 2;
  const data = bytes.subarray(1);
  return { version, data } as VersionedUpdate;
}
