import { createStorage } from "unstorage";
import memoryDriver from "unstorage/drivers/memory";

import { importEncryptionKey } from "teleportal/encryption-key";
import { Server } from "teleportal/server";
import {
  createEncryptedDriver,
  UnstorageDocumentStorage,
} from "teleportal/storage";

// import an existing encryption key
const key = await importEncryptionKey(
  "s1RZEGnuBelCbov-WC6dvddacpT1pzGmhmeVHKr-1Zg",
);
// create a new encryption key
// const key = await createEncryptionKey();

const server = new Server({
  storage: new UnstorageDocumentStorage(
    createStorage({
      // encrypts data before writing it to the driver
      driver: createEncryptedDriver(
        // use any driver you like (e.g. sqlite, redis, sql, etc.)
        memoryDriver(),
        key,
      ),
    }),
  ),
});
