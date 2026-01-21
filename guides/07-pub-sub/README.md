# Pub/Sub

This guide demonstrates a multi-server setup using pub/sub for horizontal scaling. Multiple server instances share a pub/sub backend to synchronize document updates across nodes.

## What it demonstrates

- Setting up multiple Teleportal server instances
- Using `InMemoryPubSub` (or Redis/RabbitMQ for production) to coordinate between servers
- Horizontal scaling by running multiple server nodes
- Clients can connect to any server instance and receive updates from all nodes
