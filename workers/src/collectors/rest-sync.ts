import { DataSource } from "@prisma/client";
import type { W3WPredictionRestAPI } from "@binance/w3w-prediction";
import { env } from "@/lib/config/env";
import { childLogger } from "@/lib/logger";
import { OfficialPredictionAdapter } from "@/lib/binance/prediction-adapter";
import { ingestRaw, rememberTopicIndex, type TopicIndex, type TopicIndexTopic } from "@/lib/ingest/raw-store";
import { upsertNormalizedTopic } from "@/lib/normalize/store";
import { sleep } from "@/lib/binance/rate-limit";

const log = childLogger({ component: "collector-rest" });

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

export async function runRestSyncOnce(
  adapter = OfficialPredictionAdapter.fromEnv(),
): Promise<TopicIndex> {
  const observedAt = new Date();
  const listing = await adapter.listMarkets({
    l1Category: env.COLLECTOR_L1_CATEGORY,
    sortBy: "VOLUME",
    orderBy: "DESC",
    offset: 0,
    limit: Math.min(100, env.COLLECTOR_MAX_TOPICS),
  });

  await ingestRaw({
    source: DataSource.REST,
    channel: "prediction.market.list",
    observedAt,
    payload: listing,
  });

  const topics: TopicIndexTopic[] = [];
  const listed = (listing.marketTopics ?? []).slice(0, env.COLLECTOR_MAX_TOPICS);

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
  log.info({ topics: topics.length }, "rest sync cycle complete");
  return index;
}

export async function startRestSynchronizer(): Promise<void> {
  log.info(
    {
      category: env.COLLECTOR_L1_CATEGORY,
      maxTopics: env.COLLECTOR_MAX_TOPICS,
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
