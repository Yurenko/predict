import { childLogger } from "@/lib/logger";
import { OfficialPredictionOrderbookWsAdapter } from "@/lib/binance/prediction-ws-adapter";
import { persistPredictionOrderbook } from "@/lib/ingest/orderbook-persist";

const log = childLogger({ component: "collector-prediction-ws" });

export async function startPredictionWsCollector(options: { exitOnSignal?: boolean } = {}): Promise<void> {
  const adapter = OfficialPredictionOrderbookWsAdapter.fromEnv();
  log.info("starting prediction orderbook websocket (aggregated topic)");

  const stop = await adapter.subscribeAggregatedOrderBook(
    (book) => persistPredictionOrderbook(book),
    (ageMs) => {
      log.error({ ageMs }, "prediction orderbook websocket stale");
    },
  );

  if (options.exitOnSignal === false) {
    void stop;
    return;
  }

  const shutdown = async () => {
    log.info("stopping prediction orderbook websocket");
    await stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
