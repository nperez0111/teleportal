With a Lamport clock, we can understand where each client is in the timeline (their ordering of messages).

A message has four properties: (lamport clock id(client id, counter), message id, update, parent message id)

There is a 1-1 mapping between a lamport clock id & and a message id.

On the server, the client will send a message with all the lamport clock ids of the messages it has received. The server can then compute the difference between the lamport clock ids of the messages it has received and the lamport clock ids of the messages it has sent. This will give us the lamport clock ids of the messages that the client is missing.

```ts
type ClientId = number;
type Counter = number;
type LamportClockId = `${ClientId}-${Counter}`;
type LamportClockMapping = Record<LamportClockId, MessageId>;
type MessageMapping = Record<MessageId, Message>;
```

The server can then fetch the messages that the client is missing from it's database. The server will then send them with their associated lamport clock ids & message ids so the client doesn't have to fetch them again.

The client will then add the messages to it's state vector. Keeping track of the lamport clock ids of the messages it has received.
