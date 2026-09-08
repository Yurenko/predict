import WebSocket from "ws";
import { childLogger } from "@/lib/logger";
import { StaleDataError } from "@/lib/binance/errors";
import { payloadHash, parseObservedAt } from "@/lib/binance/payload";
import { inc } from "@/lib/observability/metrics";

export interface ManagedWsOptions {
  name: string;
  url?: string;
  urlFactory?: () => string;
  headers?: Record<string, string>;
  staleMs: number;
  maxConnectionMs: number;
  reconnectDelayMs?: number;
  pingIntervalMs?: number;
  /** JSON payload instead of a WebSocket protocol ping (SApi WSS). */
  applicationPing?: () => unknown;
  onOpen?: (send: (payload: unknown) => void) => void;
  onMessage: (payload: unknown, meta: { observedAt: Date; hash: string }) => Promise<void> | void;
  onStale?: (ageMs: number) => void;
  extractObservedAt?: (payload: unknown) => unknown;
}

const log = childLogger({ component: "ws-connection" });

export class ManagedWebSocket {
  private socket: WebSocket | null = null;
  private stopped = false;
  private lastMessageAt = 0;
  private connectedAt = 0;
  private lastHashByKey = new Map<string, string>();
  private staleTimer: NodeJS.Timeout | null = null;
  private rotateTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnecting = false;
  private immediateRejects = 0;

  constructor(private readonly options: ManagedWsOptions) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.reconnecting = false;
    this.clearTimers();
    await this.closeSocket();
  }

  get lastMessageAgeMs(): number {
    if (!this.lastMessageAt) return Number.POSITIVE_INFINITY;
    return Date.now() - this.lastMessageAt;
  }

  private connect(): void {
    if (this.stopped) return;
    this.closeSocket();
    this.connectedAt = Date.now();
    const url = this.options.urlFactory?.() ?? this.options.url;
    if (!url) {
      throw new Error(`websocket ${this.options.name} is missing url`);
    }
    log.info({ name: this.options.name }, "websocket connecting");

    const socket = new WebSocket(url, {
      headers: this.options.headers,
    });
    this.socket = socket;

    socket.on("open", () => {
      log.info({ name: this.options.name }, "websocket open");
      this.armWatchdogs(socket);
      try {
        this.options.onOpen?.((payload) => this.sendJson(payload));
      } catch (error) {
        log.warn({ name: this.options.name, err: String(error) }, "websocket onOpen failed");
      }
    });

    socket.on("message", (raw) => {
      void this.handleMessage(raw.toString());
    });

    socket.on("ping", () => {
      this.lastMessageAt = Date.now();
    });

    socket.on("error", (error) => {
      log.warn({ name: this.options.name, err: error.message }, "websocket error");
    });

    socket.on("close", (code, reason) => {
      const reasonText = reason.toString();
      const lifetimeMs = Date.now() - this.connectedAt;
      const plan = reconnectDelayAfterClose({
        baseDelayMs: this.options.reconnectDelayMs ?? 2_000,
        lifetimeMs,
        code,
        reason: reasonText,
        immediateRejects: this.immediateRejects,
      });
      this.immediateRejects = plan.nextImmediateRejects;
      if (plan.immediate) {
        log.warn(
          {
            name: this.options.name,
            code,
            reason: reasonText,
            delayMs: plan.delayMs,
            attempt: this.immediateRejects,
          },
          "websocket closed immediately (Bye/auth); backing off",
        );
      } else {
        log.warn(
          { name: this.options.name, code, reason: reasonText },
          "websocket closed",
        );
      }
      if (!this.stopped) {
        this.scheduleReconnect(plan.delayMs);
      }
    });
  }

  private async handleMessage(text: string): Promise<void> {
    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      log.warn({ name: this.options.name }, "websocket message is not JSON");
      return;
    }

    const observedAt =
      parseObservedAt(this.options.extractObservedAt?.(payload)) ?? new Date();
    if (!observedAt) {
      log.warn({ name: this.options.name }, "dropped websocket message with invalid timestamp");
      return;
    }

    const hash = payloadHash(payload);
    const duplicateKey = this.options.name;
    if (this.lastHashByKey.get(duplicateKey) === hash) {
      this.lastMessageAt = Date.now();
      return;
    }
    this.lastHashByKey.set(duplicateKey, hash);
    this.lastMessageAt = Date.now();
    this.immediateRejects = 0;

    await this.options.onMessage(payload, { observedAt, hash });
  }

  private armWatchdogs(socket: WebSocket): void {
    this.clearTimers();
    this.lastMessageAt = Date.now();

    const pingEvery = effectivePingIntervalMs(
      this.options.staleMs,
      this.options.pingIntervalMs,
    );
    if (pingEvery) {
      this.pingTimer = setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        if (this.options.applicationPing) {
          this.sendJson(this.options.applicationPing());
          this.lastMessageAt = Date.now();
          return;
        }
        socket.ping();
      }, pingEvery);
    }

    this.staleTimer = setInterval(() => {
      const age = this.lastMessageAgeMs;
      if (age > this.options.staleMs) {
        log.error({ name: this.options.name, age }, "stale websocket data, reconnecting");
        inc("ws.stale", { stream: this.options.name });
        this.options.onStale?.(age);
        this.scheduleReconnect();
      }
    }, Math.min(5_000, this.options.staleMs));

    const remaining = Math.max(
      1_000,
      this.options.maxConnectionMs - (Date.now() - this.connectedAt),
    );
    this.rotateTimer = setTimeout(() => {
      log.info({ name: this.options.name }, "24h connection rotation");
      this.scheduleReconnect(0);
    }, remaining);
  }

  private scheduleReconnect(delayMs?: number): void {
    if (this.stopped || this.reconnecting) return;
    this.reconnecting = true;
    inc("ws.reconnect", { stream: this.options.name });
    const delay = delayMs ?? this.options.reconnectDelayMs ?? 2_000;
    this.clearTimers();
    void this.closeSocket();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnecting = false;
      if (!this.stopped) {
        this.connect();
      }
    }, delay);
  }

  private clearTimers(): void {
    if (this.staleTimer) clearInterval(this.staleTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.rotateTimer) clearTimeout(this.rotateTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.staleTimer = null;
    this.pingTimer = null;
    this.rotateTimer = null;
    this.reconnectTimer = null;
  }

  private sendJson(payload: unknown): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(payload));
  }

  private async closeSocket(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      try {
        socket.terminate();
      } catch {
        resolve();
      }
      setTimeout(resolve, 250);
    });
  }
}

/** Keepalive must beat the stale watchdog or a quiet orderbook reconnects forever. */
export function effectivePingIntervalMs(
  staleMs: number,
  pingIntervalMs?: number,
): number | null {
  if (!pingIntervalMs || pingIntervalMs <= 0) return null;
  return Math.min(pingIntervalMs, Math.max(1_000, Math.floor(staleMs / 2)));
}

export function reconnectDelayAfterClose(options: {
  baseDelayMs: number;
  lifetimeMs: number;
  code: number;
  reason: string;
  immediateRejects: number;
}): { delayMs: number; nextImmediateRejects: number; immediate: boolean } {
  const immediate =
    options.lifetimeMs < 2_000 && (options.code === 1000 || /bye/i.test(options.reason));
  if (!immediate) {
    return { delayMs: options.baseDelayMs, nextImmediateRejects: 0, immediate: false };
  }
  const rejects = options.immediateRejects + 1;
  const delayMs = Math.min(60_000, options.baseDelayMs * 2 ** Math.min(rejects - 1, 5));
  return { delayMs, nextImmediateRejects: rejects, immediate: true };
}

export function assertFresh(ageMs: number, staleMs: number, component: string): void {
  if (ageMs > staleMs) {
    throw new StaleDataError(component, ageMs);
  }
}
