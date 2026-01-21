# Encryption at Rest

This guide demonstrates encrypting documents before storing them in the storage backend. Data is encrypted using a symmetric encryption key.

## What it demonstrates

- Using `createEncryptedDriver` to wrap a storage driver with encryption
- Importing or creating encryption keys with `importEncryptionKey` and `createEncryptionKey`
- Encrypting document data before it's written to the underlying storage driver
- Decrypting document data when reading from storage
