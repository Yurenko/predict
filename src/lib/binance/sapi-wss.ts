import { createHmac, randomBytes } from "node:crypto";

export const PREDICTION_ORDERBOOK_AGGREGATED_TOPIC = "web3_prediction_orderbook_data";
export const SAPI_WSS_BASE_URL = "wss://api.binance.com/sapi/wss";

export function predictionOrderbookTopic(marketId: string | number): string {
  return `web3_prediction_orderbook_${marketId}`;
}

/**
 * Official SApi WSS URL.
 * Params (excluding signature) are sorted alphabetically, then HMAC-SHA256.
 * @see https://developers.binance.com/en/docs/products/w3w-prediction/websocket-api/orderbook.md
 */
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
  const row = body as Partial<PredictionOrderbookPayload>;
  if (row.msgType !== "orderbook" || typeof row.marketId !== "number") {
    return null;
  }
  if (typeof row.updateTimestampMs !== "number" || !Number.isFinite(row.updateTimestampMs)) {
    return null;
  }
  if (!Array.isArray(row.asks) || !Array.isArray(row.bids)) {
    return null;
  }
  return {
    msgType: "orderbook",
    marketId: row.marketId,
    updateTimestampMs: row.updateTimestampMs,
    asks: row.asks as Array<[string, string]>,
    bids: row.bids as Array<[string, string]>,
  };
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
