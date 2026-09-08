import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { ManagedWebSocket, effectivePingIntervalMs, reconnectDelayAfterClose } from "./ws-connection";

describe("ManagedWebSocket", () => {
  let server: WebSocketServer | undefined;
  let client: ManagedWebSocket | undefined;

  afterEach(async () => {
    await client?.stop();
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  });

  it("reconnects after the server closes the socket", async () => {
    server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server?.once("listening", () => resolve()));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    if (!port) {
      throw new Error("websocket test server did not bind a port");
    }
    let connections = 0;

    server.on("connection", (socket) => {
      connections += 1;
      socket.send(JSON.stringify({ E: Date.now(), n: connections }));
      if (connections === 1) {
        socket.close();
      }
    });

    const seen: number[] = [];
    client = new ManagedWebSocket({
      name: "test",
      url: `ws://127.0.0.1:${port}`,
      staleMs: 30_000,
      maxConnectionMs: 30_000,
      reconnectDelayMs: 40,
      onMessage: (payload) => {
        seen.push((payload as { n: number }).n);
      },
    });
    client.start();

    await viWaitUntil(() => connections >= 2 && seen.length >= 2, 4_000);
    expect(connections).toBeGreaterThanOrEqual(2);
  });

  it("sends onOpen payload after the socket opens", async () => {
    server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server?.once("listening", () => resolve()));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    if (!port) {
      throw new Error("websocket test server did not bind a port");
    }

    const received: unknown[] = [];
    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        received.push(JSON.parse(raw.toString()));
      });
    });

    client = new ManagedWebSocket({
      name: "test-open",
      url: `ws://127.0.0.1:${port}`,
      staleMs: 30_000,
      maxConnectionMs: 30_000,
      onOpen: (send) => send({ command: "SUBSCRIBE", value: ["topic"] }),
      onMessage: () => undefined,
    });
    client.start();

    await viWaitUntil(() => received.length >= 1, 4_000);
    expect(received[0]).toEqual({ command: "SUBSCRIBE", value: ["topic"] });
  });
});

describe("effectivePingIntervalMs", () => {
  it("pings before the stale watchdog on a quiet prediction book", () => {
    expect(effectivePingIntervalMs(15_000, 30_000)).toBe(7_500);
    expect(effectivePingIntervalMs(15_000, 8_000)).toBe(7_500);
  });
});

describe("reconnectDelayAfterClose", () => {
  it("backs off when the server says Bye immediately", () => {
    const first = reconnectDelayAfterClose({
      baseDelayMs: 3_000,
      lifetimeMs: 20,
      code: 1000,
      reason: "Bye",
      immediateRejects: 0,
    });
    expect(first.immediate).toBe(true);
    expect(first.delayMs).toBe(3_000);
    const second = reconnectDelayAfterClose({
      baseDelayMs: 3_000,
      lifetimeMs: 20,
      code: 1000,
      reason: "Bye",
      immediateRejects: first.nextImmediateRejects,
    });
    expect(second.delayMs).toBe(6_000);
  });

  it("uses the base delay after a normal close", () => {
    const plan = reconnectDelayAfterClose({
      baseDelayMs: 3_000,
      lifetimeMs: 10_000,
      code: 1006,
      reason: "",
      immediateRejects: 4,
    });
    expect(plan.immediate).toBe(false);
    expect(plan.delayMs).toBe(3_000);
    expect(plan.nextImmediateRejects).toBe(0);
  });
});

function viWaitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error("timed out waiting for websocket reconnect"));
      }
    }, 20);
  });
}
