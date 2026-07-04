import { describe, expect, it } from "bun:test";
import { decodeMessage } from "./decode";
import { PresenceMessage } from "./message-types";

describe("presence message encoding", () => {
  it("round-trips a presence-announce", () => {
    const message = new PresenceMessage("doc-1", {
      type: "presence-announce",
      awarenessId: 123_456_789,
    });

    const decoded = decodeMessage(message.encoded);

    expect(decoded.type).toBe("presence");
    expect(decoded.document).toBe("doc-1");
    expect(decoded.encrypted).toBe(false);
    expect(decoded.payload).toEqual({
      type: "presence-announce",
      awarenessId: 123_456_789,
    });
  });

  it("round-trips a presence-join with a data bag", () => {
    const message = new PresenceMessage("doc-2", {
      type: "presence-join",
      awarenessId: 42,
      clientId: "conn-abc",
      userId: "user-1",
      data: { userName: "Alice", color: "#f00", nested: { ok: true } },
    });

    const decoded = decodeMessage(message.encoded);

    expect(decoded.payload).toEqual({
      type: "presence-join",
      awarenessId: 42,
      clientId: "conn-abc",
      userId: "user-1",
      data: { userName: "Alice", color: "#f00", nested: { ok: true } },
    });
  });

  it("round-trips a presence-leave (with empty data)", () => {
    const message = new PresenceMessage("doc-3", {
      type: "presence-leave",
      awarenessId: 7,
      clientId: "conn-xyz",
      userId: "user-2",
      data: {},
    });

    const decoded = decodeMessage(message.encoded);

    expect(decoded.payload).toEqual({
      type: "presence-leave",
      awarenessId: 7,
      clientId: "conn-xyz",
      userId: "user-2",
      data: {},
    });
  });

  it("round-trips a presence-heartbeat with multiple clients", () => {
    const message = new PresenceMessage("doc-4", {
      type: "presence-heartbeat",
      clients: [
        {
          awarenessId: 1,
          clientId: "conn-a",
          userId: "user-a",
          data: { userName: "Alice", nested: { ok: true } },
        },
        {
          awarenessId: 2,
          clientId: "conn-b",
          userId: "user-b",
          data: {},
        },
      ],
    });

    const decoded = decodeMessage(message.encoded);

    expect(decoded.type).toBe("presence");
    expect(decoded.payload).toEqual({
      type: "presence-heartbeat",
      clients: [
        {
          awarenessId: 1,
          clientId: "conn-a",
          userId: "user-a",
          data: { userName: "Alice", nested: { ok: true } },
        },
        { awarenessId: 2, clientId: "conn-b", userId: "user-b", data: {} },
      ],
    });
  });

  it("round-trips a presence-unannounce", () => {
    const message = new PresenceMessage("doc-6", {
      type: "presence-unannounce",
      awarenessId: 987_654,
    });

    const decoded = decodeMessage(message.encoded);

    expect(decoded.type).toBe("presence");
    expect(decoded.document).toBe("doc-6");
    expect(decoded.encrypted).toBe(false);
    expect(decoded.payload).toEqual({
      type: "presence-unannounce",
      awarenessId: 987_654,
    });
  });

  it("round-trips a presence-heartbeat with an empty roster", () => {
    const message = new PresenceMessage("doc-5", {
      type: "presence-heartbeat",
      clients: [],
    });

    const decoded = decodeMessage(message.encoded);

    expect(decoded.payload).toEqual({ type: "presence-heartbeat", clients: [] });
  });
});
