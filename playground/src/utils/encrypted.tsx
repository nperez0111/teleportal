import { fromBase64, toBase64 } from "lib0/buffer";
import { createMutex } from "lib0/mutex";
import { useEffect, useState } from "react";
import {
  createEncryptionKey,
  exportEncryptionKey,
  importEncryptionKey,
} from "teleportal/encryption-key";
import { getEncryptedTransport as getEncryptedTransportBase } from "teleportal/transports";
import { Awareness } from "y-protocols/awareness.js";
import * as Y from "yjs";
import { EncryptionClient } from "../../../src/transports/encrypted/client";

/**
 * Wraps a transport with encryption secured by the provided key
 * @param key - The encryption key to use
 */
export function getEncryptedTransport(key: CryptoKey) {
  return ({
    document,
    ydoc,
    awareness,
  }: {
    document: string;
    ydoc: Y.Doc;
    awareness: Awareness;
  }) => {
    const prefix = "teleportal-encrypted-" + document;
    const snapshotKey = prefix + "-snapshot";
    const updatesKey = prefix + "-updates";

    const readSnapshot = () => {
      const raw = localStorage.getItem(snapshotKey);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as {
          id: string;
          parentSnapshotId?: string | null;
          payload: string;
        };
        return {
          id: parsed.id,
          parentSnapshotId: parsed.parentSnapshotId ?? null,
          payload: fromBase64(parsed.payload),
        };
      } catch {
        return null;
      }
    };

    const readUpdates = () => {
      const raw = localStorage.getItem(updatesKey);
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw) as Array<{
          id: string;
          snapshotId: string;
          clientId: number;
          counter: number;
          payload: string;
          serverVersion?: number;
        }>;
        return parsed.map((update) => ({
          id: update.id,
          snapshotId: update.snapshotId,
          timestamp: [update.clientId, update.counter] as [number, number],
          payload: fromBase64(update.payload),
          serverVersion: update.serverVersion,
        }));
      } catch {
        return [];
      }
    };

    const writeUpdates = (
      updates: Array<{
        id: string;
        snapshotId: string;
        timestamp: [number, number];
        payload: Uint8Array;
        serverVersion?: number;
      }>,
    ) => {
      const serialized = updates.map((update) => ({
        id: update.id,
        snapshotId: update.snapshotId,
        clientId: update.timestamp[0],
        counter: update.timestamp[1],
        payload: toBase64(update.payload),
        serverVersion: update.serverVersion,
      }));
      localStorage.setItem(updatesKey, JSON.stringify(serialized));
    };

    const client = new EncryptionClient({
      document,
      ydoc,
      awareness,
      key,
    });
    const snapshot = readSnapshot();
    const updates = readUpdates();
    if (snapshot || updates.length > 0) {
      client.loadState({ snapshot, updates }).catch((err) => {
        console.error("Failed to load encrypted state from storage", err);
        localStorage.removeItem(snapshotKey);
        localStorage.removeItem(updatesKey);
      });
    }

    client.on("snapshot-stored", (snapshot) => {
      localStorage.setItem(
        snapshotKey,
        JSON.stringify({
          id: snapshot.id,
          parentSnapshotId: snapshot.parentSnapshotId ?? null,
          payload: toBase64(snapshot.payload),
        }),
      );
      // New snapshot supersedes all previous updates; clear them so we don't
      // reload obsolete updates on next startup (which would be queued as
      // mismatched and grow memory/storage).
      writeUpdates([]);
    });

    const toStoredUpdate = (update: {
      id: string;
      snapshotId: string;
      timestamp: [number, number];
      payload: Uint8Array;
      serverVersion?: number;
    }) => ({
      id: update.id,
      snapshotId: update.snapshotId,
      timestamp: update.timestamp,
      payload: new Uint8Array(update.payload),
      serverVersion: update.serverVersion,
    });

    const updatesMutex = createMutex();
    const upsertUpdate = (update: {
      id: string;
      snapshotId: string;
      timestamp: [number, number];
      payload: Uint8Array;
      serverVersion?: number;
    }) => {
      updatesMutex(() => {
        const current = readUpdates();
        const index = current.findIndex((item) => item.id === update.id);
        if (index >= 0) {
          current[index] = toStoredUpdate({
            ...current[index],
            ...update,
            serverVersion: update.serverVersion ?? current[index].serverVersion,
          });
        } else {
          current.push(
            toStoredUpdate({ ...update, serverVersion: update.serverVersion }),
          );
        }
        writeUpdates(current);
      });
    };

    client.on("update-stored", upsertUpdate);
    client.on("update-acknowledged", upsertUpdate);

    return getEncryptedTransportBase(client);
  };
}

/**
 * React hook to manage an encryption key and its string representation
 * @param providedKey - Optional initial CryptoKey to use
 * @returns Object containing:
 *  - key: The current CryptoKey or null
 *  - keyString: String representation of the current key
 *  - setKey: Function to update the key from a string
 */
export function useEncryptionKey(providedKey?: CryptoKey) {
  const [key, setKey] = useState<CryptoKey | null>(null);
  const [keyString, setKeyString] = useState<string>("");

  useEffect(() => {
    async function initializeKey() {
      if (providedKey) {
        setKey(providedKey);
        const exported = await exportEncryptionKey(providedKey);
        setKeyString(exported);
      }
    }
    initializeKey();
  }, [providedKey]);

  const setNewKey = async (newKeyString: string) => {
    try {
      const newKey = await importEncryptionKey(newKeyString);
      setKey(newKey);
      setKeyString(newKeyString);
    } catch (error) {
      console.error("Failed to import key:", error);
    }
  };

  return {
    key,
    keyString,
    setKey: setNewKey,
  };
}

/**
 * React hook that manages an encryption key stored in the URL hash
 * Extends useEncryptionKey to automatically sync the key with the URL
 * @returns Object containing:
 *  - key: The current CryptoKey or null
 *  - keyString: String representation of the current key
 *  - setKey: Function to update both the key and URL hash
 */
export function useEncryptionKeyFromUrl(isEncrypted: boolean = false) {
  const baseKey = useEncryptionKey();

  const setNewKey = async (newKeyString: string) => {
    await baseKey.setKey(newKeyString);
    window.location.hash = `token=${newKeyString}`;
  };

  useEffect(() => {
    async function initializeFromUrl() {
      const hash = window.location.hash;
      const tokenMatch = hash.match(/token=([^&]+)/);

      if (tokenMatch) {
        try {
          await baseKey.setKey(tokenMatch[1]);
        } catch (error) {
          console.error("Failed to import key from URL:", error);
        }
      } else if (isEncrypted) {
        const key = await createEncryptionKey();
        const exported = await exportEncryptionKey(key);

        setNewKey(exported);
      }
    }

    initializeFromUrl();
  }, [isEncrypted]);

  return {
    ...baseKey,
    setKey: setNewKey,
  };
}
