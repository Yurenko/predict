import { DataSource, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { toJsonSafe } from "@/lib/binance/payload";
import { childLogger } from "@/lib/logger";
import {
  normalizeMarketDetail,
  pickPrimaryOutcome,
  type MarketDetailInput,
  type NormalizedTopic,
} from "@/lib/normalize/markets";
import { normalizeOrderbook, timeToExpirySec } from "@/lib/normalize/orderbook";
import { normalizeUnderlyingTicker } from "@/lib/normalize/underlying";
import type { PredictionOrderbookPayload } from "@/lib/binance/sapi-wss";
import type { UnderlyingTicker } from "@/lib/binance/market-data-adapter";

const log = childLogger({ component: "normalize-store" });

interface MarketCacheEntry {
  marketDbId: string;
  outcomeDbId: string | null;
  endDate: Date | null;
}

const marketCache = new Map<string, MarketCacheEntry>();

function json(value: unknown): Prisma.InputJsonValue {
  return toJsonSafe(value) as Prisma.InputJsonValue;
}

export async function upsertNormalizedTopic(detail: MarketDetailInput): Promise<NormalizedTopic | null> {
  const topic = normalizeMarketDetail(detail);
  if (!topic) return null;

  try {
    const savedTopic = await prisma.marketTopic.upsert({
      where: { marketTopicId: topic.marketTopicId },
      create: {
        marketTopicId: topic.marketTopicId,
        vendor: topic.vendor,
        chainId: topic.chainId,
        slug: topic.slug,
        title: topic.title,
        question: topic.question,
        description: topic.description,
        imageUrl: topic.imageUrl,
        topicType: topic.topicType,
        chartType: topic.chartType,
        symbol: topic.symbol,
        collateral: topic.collateral,
        feeRateBps: topic.feeRateBps,
        slippageBps: topic.slippageBps,
        isYieldBearing: topic.isYieldBearing,
        tradeVolume: topic.tradeVolume,
        liquidity: topic.liquidity,
        participantCount: topic.participantCount,
        status: topic.status,
        startPrice: topic.startPrice,
        endPrice: topic.endPrice,
        priceFeedId: topic.priceFeedId,
        priceFeedProvider: topic.priceFeedProvider,
        priceFeedSymbol: topic.priceFeedSymbol,
        publishedAt: topic.publishedAt,
        startDate: topic.startDate,
        endDate: topic.endDate,
        rawPayload: json(detail),
      },
      update: {
        vendor: topic.vendor,
        title: topic.title,
        question: topic.question,
        symbol: topic.symbol,
        status: topic.status,
        feeRateBps: topic.feeRateBps,
        slippageBps: topic.slippageBps,
        tradeVolume: topic.tradeVolume,
        liquidity: topic.liquidity,
        startPrice: topic.startPrice,
        endPrice: topic.endPrice,
        priceFeedSymbol: topic.priceFeedSymbol,
        endDate: topic.endDate,
        rawPayload: json(detail),
      },
    });

    for (const market of topic.markets) {
      const savedMarket = await prisma.market.upsert({
        where: { venueMarketId: market.venueMarketId },
        create: {
          topicId: savedTopic.id,
          venueMarketId: market.venueMarketId,
          externalId: market.externalId,
          title: market.title,
          question: market.question,
          description: market.description,
          conditionId: market.conditionId,
          status: market.status,
          tradingStatus: market.tradingStatus,
          tradeVolume: market.tradeVolume,
          liquidity: market.liquidity,
          decimalPrecision: market.decimalPrecision,
          rawPayload: json(detail),
        },
        update: {
          topicId: savedTopic.id,
          title: market.title,
          status: market.status,
          tradingStatus: market.tradingStatus,
          tradeVolume: market.tradeVolume,
          liquidity: market.liquidity,
          rawPayload: json(detail),
        },
      });

      let primaryId: string | null = null;
      const primary = pickPrimaryOutcome(market.outcomes);
      for (const outcome of market.outcomes) {
        const saved = await prisma.marketOutcome.upsert({
          where: { tokenId: outcome.tokenId },
          create: {
            marketId: savedMarket.id,
            tokenId: outcome.tokenId,
            name: outcome.name,
            outcomeIndex: outcome.outcomeIndex,
            lastChance: outcome.lastChance,
            lastPrice: outcome.lastPrice,
          },
          update: {
            marketId: savedMarket.id,
            name: outcome.name,
            lastChance: outcome.lastChance,
            lastPrice: outcome.lastPrice,
          },
        });
        if (primary && outcome.tokenId === primary.tokenId) {
          primaryId = saved.id;
        }
      }

      marketCache.set(market.venueMarketId, {
        marketDbId: savedMarket.id,
        outcomeDbId: primaryId,
        endDate: topic.endDate,
      });

      await prisma.marketTopic.deleteMany({
        where: {
          marketTopicId: `pending:${market.venueMarketId}`,
          markets: { none: {} },
        },
      });
    }
  } catch (error) {
    log.warn({ err: String(error), topic: topic.marketTopicId }, "normalized topic upsert skipped");
  }

  return topic;
}

async function ensureMarket(venueMarketId: string): Promise<MarketCacheEntry | null> {
  const cached = marketCache.get(venueMarketId);
  if (cached) return cached;

  try {
    const existing = await prisma.market.findUnique({
      where: { venueMarketId },
      include: { topic: true, outcomes: true },
    });
    if (existing) {
      const primary = pickPrimaryOutcome(
        existing.outcomes.map((outcome) => ({
          tokenId: outcome.tokenId,
          name: outcome.name,
          outcomeIndex: outcome.outcomeIndex,
          lastChance: null,
          lastPrice: null,
        })),
      );
      const entry: MarketCacheEntry = {
        marketDbId: existing.id,
        outcomeDbId: primary
          ? (existing.outcomes.find((row) => row.tokenId === primary.tokenId)?.id ?? null)
          : (existing.outcomes[0]?.id ?? null),
        endDate: existing.topic.endDate,
      };
      marketCache.set(venueMarketId, entry);
      return entry;
    }

    const stubTopic = await prisma.marketTopic.upsert({
      where: { marketTopicId: `pending:${venueMarketId}` },
      create: {
        marketTopicId: `pending:${venueMarketId}`,
        title: `pending market ${venueMarketId}`,
        status: "PENDING_METADATA",
      },
      update: {},
    });
    try {
      const stubMarket = await prisma.market.create({
        data: {
          topicId: stubTopic.id,
          venueMarketId,
          title: `market-${venueMarketId}`,
          status: "PENDING_METADATA",
        },
      });
      const entry: MarketCacheEntry = {
        marketDbId: stubMarket.id,
        outcomeDbId: null,
        endDate: null,
      };
      marketCache.set(venueMarketId, entry);
      return entry;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        marketCache.delete(venueMarketId);
        return ensureMarket(venueMarketId);
      }
      throw error;
    }
  } catch (error) {
    log.warn({ err: String(error), venueMarketId }, "ensureMarket failed");
    return null;
  }
}

export async function insertNormalizedOrderbook(
  book: PredictionOrderbookPayload,
): Promise<boolean> {
  const snapshot = normalizeOrderbook(book);
  const market = await ensureMarket(snapshot.venueMarketId);
  if (!market) return false;

  try {
    await prisma.marketSnapshot.create({
      data: {
        marketId: market.marketDbId,
        outcomeId: market.outcomeDbId,
        observedAt: snapshot.observedAt,
        source: DataSource.WEBSOCKET,
        lastPrice: snapshot.lastPrice,
        chance: snapshot.chance,
        bestBid: snapshot.bestBid,
        bestAsk: snapshot.bestAsk,
        midPrice: snapshot.midPrice,
        spread: snapshot.spread,
        liquidity: snapshot.liquidity,
        bidDepth: snapshot.bidDepth,
        askDepth: snapshot.askDepth,
        sequence: snapshot.sequence,
        timeToExpirySec: timeToExpirySec(market.endDate, snapshot.observedAt),
        rawPayload: json(book),
      },
    });
    if (market.outcomeDbId && snapshot.chance) {
      await prisma.marketOutcome.update({
        where: { id: market.outcomeDbId },
        data: { lastChance: snapshot.chance },
      });
    }
    return true;
  } catch (error) {
    log.warn({ err: String(error), marketId: book.marketId }, "orderbook snapshot skipped");
    return false;
  }
}

export async function insertNormalizedUnderlying(
  ticker: UnderlyingTicker,
  source: DataSource = DataSource.WEBSOCKET,
): Promise<boolean> {
  const snapshot = normalizeUnderlyingTicker(ticker);
  if (!snapshot) return false;
  try {
    await prisma.underlyingSnapshot.create({
      data: {
        symbol: snapshot.symbol,
        observedAt: snapshot.observedAt,
        source,
        price: snapshot.price,
        bid: snapshot.bid,
        ask: snapshot.ask,
        volume: snapshot.volume,
        rawPayload: json(ticker.raw),
      },
    });
    return true;
  } catch (error) {
    log.warn({ err: String(error), symbol: ticker.symbol }, "underlying snapshot skipped");
    return false;
  }
}
