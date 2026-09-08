import { DataSource } from "@prisma/client";
import type { W3WPredictionRestAPI } from "@binance/w3w-prediction";
import { env } from "@/lib/config/env";
import { childLogger } from "@/lib/logger";
import {
  OfficialPredictionAdapter,
  type ListMarketsParams,
} from "@/lib/binance/prediction-adapter";
import { restOrderBookToPayload } from "@/lib/binance/sapi-wss";
import { persistPredictionOrderbook } from "@/lib/ingest/orderbook-persist";
import { ingestRaw, rememberTopicIndex, type TopicIndex, type TopicIndexTopic } from "@/lib/ingest/raw-store";
import {
  LIST_MAX_PAGES,
  LIST_PAGE_SIZE,
  parseCollectorCategories,
  pickDiscoveredTopics,
  selectHorizonTopics,
  uniqueTopicsById,
} from "@/lib/markets/horizon";
import { pickPrimaryOutcome } from "@/lib/normalize/markets";
import { upsertNormalizedTopic } from "@/lib/normalize/store";
import { sleep } from "@/lib/binance/rate-limit";

const log = childLogger({ component: "collector-rest" });

type ListedTopic = NonNullable<
  W3WPredictionRestAPI.ListPredictionMarketsResponse["marketTopics"]
>[number];

function asId(value: unknown): string | null {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return null;
}

function topicFromDetail(
  detail: W3WPredictionRestAPI.GetMarketDetailResponse,
): TopicIndexTopic | null {
  const marketTopicId = asId(detail.marketTopicId);
  if (!marketTopicId) return null;

  const markets = (detail.markets ?? []).flatMap((market) => {
    const marketId = asId(market.marketId);
    if (!marketId) return [];
    const outcomes = (market.outcomes ?? []).flatMap((outcome) => {
      if (!outcome.tokenId) return [];
      return [{ tokenId: outcome.tokenId, name: outcome.name }];
    });
    return [{ marketId, vendor: detail.vendor, outcomes }];
  });

  return {
    marketTopicId,
    vendor: detail.vendor,
    symbol: detail.symbol,
    markets,
  };
}

async function listNearExpiryTopics(
  adapter: OfficialPredictionAdapter,
  observedAt: Date,
): Promise<ListedTopic[]> {
  const now = observedAt;
  const minSec = env.MIN_TIME_TO_EXPIRY_SEC;
  const maxSec = env.COLLECTOR_MAX_TIME_TO_EXPIRY_SEC;
  const collected: ListedTopic[] = [];

  for (const category of parseCollectorCategories()) {
    for (let page = 0; page < LIST_MAX_PAGES; page += 1) {
      const listing = await adapter.listMarkets({
        ...(category ? { l1Category: category } : {}),
        sortBy: "END_DATE" as ListMarketsParams["sortBy"],
        orderBy: "ASC" as ListMarketsParams["orderBy"],
        offset: page * LIST_PAGE_SIZE,
        limit: LIST_PAGE_SIZE,
      });

      await ingestRaw({
        source: DataSource.REST,
        channel: "prediction.market.list",
        observedAt,
        payload: { category: category ?? "all", page, listing },
      });

      const listed = listing.marketTopics ?? [];
      if (listed.length === 0) break;

      const { keep, hitFar } = selectHorizonTopics(listed, now, minSec, maxSec);
      collected.push(...keep);
      if (hitFar || listed.length < LIST_PAGE_SIZE) break;
    }
  }

  return pickDiscoveredTopics(uniqueTopicsById(collected), env.COLLECTOR_MAX_TOPICS);
}

export async function runRestSyncOnce(
  adapter = OfficialPredictionAdapter.fromEnv(),
): Promise<TopicIndex> {
  log.info(
    {
      category: env.COLLECTOR_L1_CATEGORY || "all",
      maxTopics: env.COLLECTOR_MAX_TOPICS,
      maxTimeToExpirySec: env.COLLECTOR_MAX_TIME_TO_EXPIRY_SEC,
    },
    "REST market discovery starting (near-expiry only)",
  );
  const observedAt = new Date();
  const listed = await listNearExpiryTopics(adapter, observedAt);

  const topics: TopicIndexTopic[] = [];
  for (const listedTopic of listed) {
    const topicId = asId(listedTopic.marketTopicId);
    if (!topicId) continue;

    const detail = await adapter.getMarketDetail(topicId);
    await ingestRaw({
      source: DataSource.REST,
      channel: `prediction.market.detail.${topicId}`,
      observedAt: new Date(),
      payload: detail,
    });
    await upsertNormalizedTopic(detail);

    const indexed = topicFromDetail(detail);
    if (indexed) topics.push(indexed);
  }

  const index: TopicIndex = { updatedAt: new Date().toISOString(), topics };
  await rememberTopicIndex(index);
  log.info(
    {
      topics: topics.length,
      titles: listed.map((row) => row.title ?? row.question ?? asId(row.marketTopicId)),
    },
    "rest sync cycle complete",
  );
  void seedRestOrderbooks(adapter, index).catch((error: unknown) => {
    log.warn({ err: String(error) }, "REST orderbook seed failed");
  });
  return index;
}

function toNumericId(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  return Number(value);
}

/**
 * One snapshot per discovered market so paper/backtest have a book before WSS ticks arrive.
 * Not a polling loop — discovery already paid the REST interval.
 */
export async function seedRestOrderbooks(
  adapter: OfficialPredictionAdapter,
  index: TopicIndex,
): Promise<number> {
  let seeded = 0;
  const budget = env.COLLECTOR_MAX_TOPICS;

  for (const topic of index.topics) {
    if (seeded >= budget) break;
    const vendor = topic.vendor ?? topic.markets[0]?.vendor ?? "predict_fun";

    for (const market of topic.markets) {
      if (seeded >= budget) break;
      const marketId = toNumericId(market.marketId);
      const primary = pickPrimaryOutcome(
        market.outcomes.map((outcome) => ({
          tokenId: outcome.tokenId,
          name: outcome.name ?? "unknown",
          outcomeIndex: null,
          lastChance: null,
          lastPrice: null,
        })),
      );
      const tokenId = primary?.tokenId ?? market.outcomes[0]?.tokenId;
      if (marketId === null || !tokenId) continue;

      try {
        const book = await adapter.getOrderBook({ vendor, marketId, tokenId });
        const payload = restOrderBookToPayload(marketId, book);
        if (!payload || (payload.bids.length === 0 && payload.asks.length === 0)) continue;
        await persistPredictionOrderbook(payload, DataSource.REST);
        seeded += 1;
      } catch (error) {
        log.warn(
          { err: String(error), marketId: market.marketId },
          "REST orderbook seed skipped",
        );
      }
    }
  }

  log.info({ seeded, topics: index.topics.length }, "REST orderbook seed complete");
  return seeded;
}

export async function startRestSynchronizer(): Promise<void> {
  log.info(
    {
      category: env.COLLECTOR_L1_CATEGORY || "all",
      maxTopics: env.COLLECTOR_MAX_TOPICS,
      maxTimeToExpirySec: env.COLLECTOR_MAX_TIME_TO_EXPIRY_SEC,
      once: env.COLLECTOR_ONCE,
      intervalMs: env.COLLECTOR_REST_DISCOVERY_INTERVAL_MS,
    },
    "starting prediction REST metadata discovery (no order-book polling)",
  );

  const adapter = OfficialPredictionAdapter.fromEnv();

  do {
    try {
      await runRestSyncOnce(adapter);
    } catch (error) {
      log.error({ err: String(error) }, "rest discovery cycle failed");
    }
    if (env.COLLECTOR_ONCE) return;
    await sleep(env.COLLECTOR_REST_DISCOVERY_INTERVAL_MS);
  } while (true);
}
