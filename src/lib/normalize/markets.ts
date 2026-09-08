import { asDate, asDecimalString, asId, asNumber } from "@/lib/normalize/numbers";

export interface MarketDetailInput {
  marketTopicId?: number | bigint | string;
  vendor?: string;
  chainId?: string;
  slug?: string;
  title?: string;
  question?: string;
  description?: string;
  imageUrl?: string;
  topicType?: string;
  chartType?: string;
  symbol?: string;
  collateral?: string;
  feeRateBps?: number;
  slippageBps?: number;
  isYieldBearing?: boolean;
  tradeVolume?: string;
  liquidity?: string;
  participantCount?: number;
  status?: string;
  publishedAt?: number | bigint;
  startDate?: number | bigint;
  endDate?: number | bigint;
  variantData?: {
    startPrice?: string;
    endPrice?: string | null;
    priceFeedId?: string;
    priceFeedProvider?: string;
    priceFeedSymbol?: string;
  };
  markets?: Array<{
    marketId?: number | bigint | string;
    externalId?: string;
    title?: string;
    question?: string;
    description?: string;
    conditionId?: string;
    status?: string;
    tradingStatus?: string;
    tradeVolume?: string;
    liquidity?: string;
    decimalPrecision?: number;
    outcomes?: Array<{
      name?: string;
      price?: string;
      chance?: string;
      index?: number;
      tokenId?: string;
    }>;
  }>;
}

export interface NormalizedOutcome {
  tokenId: string;
  name: string;
  outcomeIndex: number | null;
  lastChance: string | null;
  lastPrice: string | null;
}

export interface NormalizedMarket {
  venueMarketId: string;
  externalId: string | null;
  title: string;
  question: string | null;
  description: string | null;
  conditionId: string | null;
  status: string | null;
  tradingStatus: string | null;
  tradeVolume: string | null;
  liquidity: string | null;
  decimalPrecision: number | null;
  outcomes: NormalizedOutcome[];
}

export interface NormalizedTopic {
  marketTopicId: string;
  vendor: string | null;
  chainId: string;
  slug: string | null;
  title: string;
  question: string | null;
  description: string | null;
  imageUrl: string | null;
  topicType: string | null;
  chartType: string | null;
  symbol: string | null;
  collateral: string | null;
  feeRateBps: number | null;
  slippageBps: number | null;
  isYieldBearing: boolean | null;
  tradeVolume: string | null;
  liquidity: string | null;
  participantCount: number | null;
  status: string | null;
  startPrice: string | null;
  endPrice: string | null;
  priceFeedId: string | null;
  priceFeedProvider: string | null;
  priceFeedSymbol: string | null;
  publishedAt: Date | null;
  startDate: Date | null;
  endDate: Date | null;
  markets: NormalizedMarket[];
}

const PRIMARY_OUTCOME = new Set(["yes", "up"]);

export function outcomeIsDownToken(name: string | null | undefined): boolean {
  const key = (name ?? "").trim().toLowerCase();
  return key === "no" || key === "down";
}

export function pickPrimaryOutcome(outcomes: NormalizedOutcome[]): NormalizedOutcome | null {
  if (outcomes.length === 0) return null;
  return (
    outcomes.find((outcome) => PRIMARY_OUTCOME.has(outcome.name.trim().toLowerCase())) ??
    outcomes[0] ??
    null
  );
}

/** Down/No token on the same Up-or-Down market. LIVE buys this instead of shorting Up. */
export function pickComplementOutcome<T extends { tokenId: string; name: string }>(
  outcomes: T[],
  primaryTokenId: string,
): T | null {
  const others = outcomes.filter((outcome) => outcome.tokenId !== primaryTokenId);
  return others.find((outcome) => outcomeIsDownToken(outcome.name)) ?? others[0] ?? null;
}

export function normalizeMarketDetail(detail: MarketDetailInput): NormalizedTopic | null {
  const marketTopicId = asId(detail.marketTopicId);
  if (!marketTopicId) return null;

  const markets = (detail.markets ?? []).flatMap((market) => {
    const venueMarketId = asId(market.marketId);
    if (!venueMarketId) return [];
    const outcomes = (market.outcomes ?? []).flatMap((outcome) => {
      if (!outcome.tokenId) return [];
      return [
        {
          tokenId: outcome.tokenId,
          name: outcome.name?.trim() || "unknown",
          outcomeIndex: typeof outcome.index === "number" ? outcome.index : null,
          lastChance: asDecimalString(outcome.chance),
          lastPrice: asDecimalString(outcome.price),
        },
      ];
    });
    return [
      {
        venueMarketId,
        externalId: market.externalId ?? null,
        title: market.title || detail.title || `market-${venueMarketId}`,
        question: market.question ?? null,
        description: market.description ?? null,
        conditionId: market.conditionId ?? null,
        status: market.status ?? null,
        tradingStatus: market.tradingStatus ?? null,
        tradeVolume: asDecimalString(market.tradeVolume),
        liquidity: asDecimalString(market.liquidity),
        decimalPrecision: market.decimalPrecision ?? null,
        outcomes,
      },
    ];
  });

  return {
    marketTopicId,
    vendor: detail.vendor ?? null,
    chainId: detail.chainId || "56",
    slug: detail.slug ?? null,
    title: detail.title || detail.question || `topic-${marketTopicId}`,
    question: detail.question ?? null,
    description: detail.description ?? null,
    imageUrl: detail.imageUrl ?? null,
    topicType: detail.topicType ?? null,
    chartType: detail.chartType ?? null,
    symbol: detail.symbol ?? null,
    collateral: detail.collateral ?? null,
    feeRateBps: typeof detail.feeRateBps === "number" ? detail.feeRateBps : null,
    slippageBps: typeof detail.slippageBps === "number" ? detail.slippageBps : null,
    isYieldBearing: detail.isYieldBearing ?? null,
    tradeVolume: asDecimalString(detail.tradeVolume),
    liquidity: asDecimalString(detail.liquidity),
    participantCount: asNumber(detail.participantCount),
    status: detail.status ?? null,
    startPrice: asDecimalString(detail.variantData?.startPrice),
    endPrice: asDecimalString(detail.variantData?.endPrice),
    priceFeedId: detail.variantData?.priceFeedId ?? null,
    priceFeedProvider: detail.variantData?.priceFeedProvider ?? null,
    priceFeedSymbol: detail.variantData?.priceFeedSymbol ?? null,
    publishedAt: asDate(detail.publishedAt),
    startDate: asDate(detail.startDate),
    endDate: asDate(detail.endDate),
    markets,
  };
}
