import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { ManagedWebSocket } from "./ws-connection";

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
