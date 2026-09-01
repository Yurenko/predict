import { DataSource } from "@prisma/client";
import { env } from "@/lib/config/env";
import { childLogger } from "@/lib/logger";
import { OfficialSpotMarketDataAdapter } from "@/lib/binance/market-data-adapter";
import { ingestRaw } from "@/lib/ingest/raw-store";
import { insertNormalizedUnderlying } from "@/lib/normalize/store";

const log = childLogger({ component: "collector-underlying-ws" });
const lastPersistAt = new Map<string, number>();

export async function startUnderlyingWsCollector(): Promise<void> {
  const symbols = env.COLLECTOR_UNDERLYING_SYMBOLS;
  const adapter = new OfficialSpotMarketDataAdapter();

  log.info({ symbols }, "starting underlying spot websocket collector");

  for (const symbol of symbols) {
    try {
      const snapshot = await adapter.getTicker(symbol);
      await ingestRaw({
        source: DataSource.REST,
        channel: `spot.ticker.${symbol}`,
        observedAt: snapshot.eventTime,
        payload: snapshot.raw,
      });
      await insertNormalizedUnderlying(snapshot, DataSource.REST);
    } catch (error) {
      log.warn({ symbol, err: String(error) }, "spot REST snapshot failed");
    }
  }

  if (env.COLLECTOR_ONCE) {
    log.info("COLLECTOR_ONCE set, skipping websocket subscribe");
    return;
  }

  const stop = await adapter.subscribeTickers(
    symbols,
    async (ticker) => {
      const result = await ingestRaw({
        source: DataSource.WEBSOCKET,
        channel: `spot.ws.ticker.${ticker.symbol}`,
        observedAt: ticker.eventTime,
        payload: ticker.raw,
      });
      if (result !== "duplicate") {
        log.debug({ symbol: ticker.symbol, price: ticker.price, result }, "underlying tick");
      }

      const now = Date.now();
      const last = lastPersistAt.get(ticker.symbol) ?? 0;
      if (now - last < env.COLLECTOR_WS_PERSIST_MIN_INTERVAL_MS) {
        return;
      }
      lastPersistAt.set(ticker.symbol, now);
      await insertNormalizedUnderlying(ticker);
    },
    (ageMs) => {
      log.error({ ageMs }, "underlying websocket stale");
      void ingestRaw({
        source: DataSource.WEBSOCKET,
        channel: "spot.ws.stale",
        observedAt: new Date(),
        payload: { ageMs, component: "underlying" },
      });
    },
  );

  const shutdown = async () => {
    log.info("stopping underlying websocket collector");
    await stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
