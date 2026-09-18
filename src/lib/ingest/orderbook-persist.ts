import { DataSource } from "@prisma/client";
import { env } from "@/lib/config/env";
import { bestPrices, type PredictionOrderbookPayload } from "@/lib/binance/sapi-wss";
import { cacheLiveOrderbook, ingestRaw } from "@/lib/ingest/raw-store";
import { hasExecutableSide } from "@/lib/ingest/orderbook-merge";
import { insertNormalizedOrderbook } from "@/lib/normalize/store";

const lastPersistAt = new Map<number, number>();

export async function persistPredictionOrderbook(
  book: PredictionOrderbookPayload,
  source: DataSource = DataSource.WEBSOCKET,
): Promise<void> {
  const { bestBid, bestAsk } = bestPrices(book);
  await cacheLiveOrderbook(book.marketId, {
    marketId: book.marketId,
    updateTimestampMs: book.updateTimestampMs,
    bestBid,
    bestAsk,
    bids: book.bids,
    asks: book.asks,
  });

  if (!hasExecutableSide({ bestBid, bestAsk })) {
    return;
  }

  const now = Date.now();
  const minInterval = env.COLLECTOR_WS_PERSIST_MIN_INTERVAL_MS;
  const last = lastPersistAt.get(book.marketId) ?? 0;
  if (now - last < minInterval) {
    return;
  }
  lastPersistAt.set(book.marketId, now);

  await ingestRaw({
    source,
    channel: `prediction.ws.orderbook.${book.marketId}`,
    observedAt: new Date(book.updateTimestampMs),
    payload: book,
  });
  await insertNormalizedOrderbook(book);
}
