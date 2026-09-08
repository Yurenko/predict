import { createHmac, randomBytes } from "node:crypto";

export const PREDICTION_ORDERBOOK_AGGREGATED_TOPIC = "web3_prediction_orderbook_data";
export const SAPI_WSS_BASE_URL = "wss://api.binance.com/sapi/wss";

export function predictionOrderbookTopic(marketId: string | number): string {
  return `web3_prediction_orderbook_${marketId}`;
}

/** SApi WSS command after connect. Topic in the URL is not enough — the socket stays silent without this. */
export function sapiSubscribeMessage(topic: string): Record<string, unknown> {
  return { command: "SUBSCRIBE", value: [topic] };
}

export function sapiPingMessage(): Record<string, unknown> {
  return { command: "PING" };
}

/**
 * Official SApi WSS URL.
 * Params (excluding signature) are sorted alphabetically, then HMAC-SHA256.
 * @see https://developers.binance.com/en/docs/products/w3w-prediction/websocket-api/orderbook.md
 */
/** Signed SAPI query. Repeated keys (tokenIds=a&tokenIds=b) stay intact for batchRedeem. */
export function buildSapiSignedQuery(options: {
  apiSecret: string;
  pairs: Array<[string, string]>;
  timestampMs?: number;
}): { query: string; payload: string; signature: string } {
  const pairs = [...options.pairs, ["timestamp", String(options.timestampMs ?? Date.now())]];
  pairs.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  const payload = pairs.map(([key, value]) => `${key}=${value}`).join("&");
  const signature = createHmac("sha256", options.apiSecret).update(payload).digest("hex");
  return { payload, signature, query: `${payload}&signature=${signature}` };
}

export function buildSapiWssUrl(options: {
  baseUrl?: string;
  apiSecret: string;
  topic: string;
  recvWindowMs?: number;
  timestampMs?: number;
  random?: string;
}): { url: string; payload: string; signature: string } {
  const params: Record<string, string> = {
    random: options.random ?? randomBytes(16).toString("hex"),
    recvWindow: String(options.recvWindowMs ?? 30_000),
    timestamp: String(options.timestampMs ?? Date.now()),
    topic: options.topic,
  };
  const payload = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
  const signature = createHmac("sha256", options.apiSecret).update(payload).digest("hex");
  const baseUrl = options.baseUrl ?? SAPI_WSS_BASE_URL;
  return {
    payload,
    signature,
    url: `${baseUrl}?${payload}&signature=${signature}`,
  };
}

export interface SapiWsEnvelope {
  type?: string;
  topic?: string;
  data?: unknown;
}

export interface PredictionOrderbookPayload {
  msgType: "orderbook";
  marketId: number;
  updateTimestampMs: number;
  asks: Array<[string, string]>;
  bids: Array<[string, string]>;
}

export function parseSapiEnvelope(raw: unknown): SapiWsEnvelope | null {
  if (!raw || typeof raw !== "object") return null;
  return raw as SapiWsEnvelope;
}

function asMarketId(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

function asTimestampMs(value: unknown): number | null {
  if (typeof value === "bigint") return asTimestampMs(Number(value));
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return asTimestampMs(Number(value));
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value > 1_000_000_000_000 ? value : value * 1000;
}

function asLevels(value: unknown): Array<[string, string]> | null {
  if (!Array.isArray(value)) return null;
  const levels: Array<[string, string]> = [];
  for (const row of value) {
    if (Array.isArray(row) && row[0] != null && row[1] != null) {
      levels.push([String(row[0]), String(row[1])]);
      continue;
    }
    if (row && typeof row === "object") {
      const item = row as { price?: unknown; size?: unknown };
      if (item.price == null || item.size == null) continue;
      levels.push([String(item.price), String(item.size)]);
    }
  }
  return levels;
}

export function parseOrderbookPayload(data: unknown): PredictionOrderbookPayload | null {
  let body: unknown = data;
  if (typeof data === "string") {
    try {
      body = JSON.parse(data) as unknown;
    } catch {
      return null;
    }
  }
  if (!body || typeof body !== "object") return null;
  const row = body as Record<string, unknown>;
  if (row.msgType != null && row.msgType !== "orderbook") return null;
  const marketId = asMarketId(row.marketId);
  const updateTimestampMs = asTimestampMs(row.updateTimestampMs ?? row.timestamp);
  const asks = asLevels(row.asks);
  const bids = asLevels(row.bids);
  if (marketId === null || updateTimestampMs === null || !asks || !bids) {
    return null;
  }
  return {
    msgType: "orderbook",
    marketId,
    updateTimestampMs,
    asks,
    bids,
  };
}

export function restOrderBookToPayload(
  marketId: string | number,
  book: {
    timestamp?: number | bigint;
    bids?: Array<{ price?: string; size?: string }>;
    asks?: Array<{ price?: string; size?: string }>;
  },
): PredictionOrderbookPayload | null {
  return parseOrderbookPayload({
    msgType: "orderbook",
    marketId,
    updateTimestampMs: book.timestamp ?? Date.now(),
    bids: book.bids,
    asks: book.asks,
  });
}

export function shouldApplyOrderbookUpdate(
  previousTs: number | undefined,
  nextTs: number,
): boolean {
  if (previousTs === undefined) return true;
  return nextTs > previousTs;
}

export function bestPrices(book: PredictionOrderbookPayload): {
  bestBid: string | null;
  bestAsk: string | null;
} {
  return {
    bestBid: book.bids[0]?.[0] ?? null,
    bestAsk: book.asks[0]?.[0] ?? null,
  };
}
