import { DataSource } from "@prisma/client";
import { env } from "@/lib/config/env";
import { childLogger } from "@/lib/logger";
import { OfficialPredictionOrderbookWsAdapter } from "@/lib/binance/prediction-ws-adapter";
import { bestPrices, type PredictionOrderbookPayload } from "@/lib/binance/sapi-wss";
import { cacheLiveOrderbook, ingestRaw } from "@/lib/ingest/raw-store";
import { insertNormalizedOrderbook } from "@/lib/normalize/store";

const log = childLogger({ component: "collector-prediction-ws" });
const lastPersistAt = new Map<number, number>();

export async function startPredictionWsCollector(): Promise<void> {
  const adapter = OfficialPredictionOrderbookWsAdapter.fromEnv();
  log.info("starting prediction orderbook websocket (aggregated topic, no REST polling)");

  const stop = await adapter.subscribeAggregatedOrderBook(
    (book) => persistBook(book),
    (ageMs) => {
      log.error({ ageMs }, "prediction orderbook websocket stale");
    },
  );

  const shutdown = async () => {
    log.info("stopping prediction orderbook websocket");
    await stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

async function persistBook(book: PredictionOrderbookPayload): Promise<void> {
  const { bestBid, bestAsk } = bestPrices(book);
  await cacheLiveOrderbook(book.marketId, {
    marketId: book.marketId,
    updateTimestampMs: book.updateTimestampMs,
    bestBid,
    bestAsk,
    bids: book.bids,
    asks: book.asks,
  });

  const now = Date.now();
  const minInterval = env.COLLECTOR_WS_PERSIST_MIN_INTERVAL_MS;
  const last = lastPersistAt.get(book.marketId) ?? 0;
  if (now - last < minInterval) {
    return;
  }
  lastPersistAt.set(book.marketId, now);

  await ingestRaw({
    source: DataSource.WEBSOCKET,
    channel: `prediction.ws.orderbook.${book.marketId}`,
    observedAt: new Date(book.updateTimestampMs),
    payload: book,
  });
  await insertNormalizedOrderbook(book);
}
