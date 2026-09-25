import type { Prisma } from "@prisma/client";
import { env } from "@/lib/config/env";
import { asDate, asId } from "@/lib/normalize/numbers";

export const DAY_SEC = 86_400;
export const LIST_PAGE_SIZE = 100;
export const LIST_MAX_PAGES = 5;

export type HorizonClass =
  | "expired"
  | "too_soon"
  | "in_window"
  | "too_far"
  | "unknown";

export interface HorizonWindow {
  now: Date;
  minSec: number;
  maxSec: number;
  endDateGte: Date;
  endDateLte: Date;
}

export function collectorHorizon(now = new Date()): HorizonWindow {
  const minSec = env.MIN_TIME_TO_EXPIRY_SEC;
  const maxSec = env.COLLECTOR_MAX_TIME_TO_EXPIRY_SEC;
  return {
    now,
    minSec,
    maxSec,
    endDateGte: new Date(now.getTime() + minSec * 1000),
    endDateLte: new Date(now.getTime() + maxSec * 1000),
  };
}

export function classifyEndDate(
  endDate: unknown,
  now: Date,
  minSec: number,
  maxSec: number,
): HorizonClass {
  const date = asDate(endDate);
  if (!date) return "unknown";
  const sec = Math.floor((date.getTime() - now.getTime()) / 1000);
  if (sec < 0) return "expired";
  if (sec < minSec) return "too_soon";
  if (sec > maxSec) return "too_far";
  return "in_window";
}

export function parseCollectorCategories(
  raw = env.COLLECTOR_L1_CATEGORY,
): Array<string | undefined> {
  const parts = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (
    parts.length === 0 ||
    parts.some((item) => item === "*" || item.toLowerCase() === "all")
  ) {
    return [undefined];
  }
  return parts;
}

export const SHORT_CRYPTO_SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT"] as const;

export interface ListedTopicLike {
  marketTopicId?: number | bigint | string;
  endDate?: number | bigint | string | Date | null;
  title?: string | null;
  question?: string | null;
  symbol?: string | null;
}

function topicSearchText(topic: ListedTopicLike): string {
  return [topic.title, topic.question, topic.symbol]
    .filter(
      (part): part is string =>
        typeof part === "string" && part.trim().length > 0,
    )
    .join(" ");
}

export function minutesBetweenClockRange(text: string): number | null {
  const range = text.match(
    /(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\s*-\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i,
  );
  if (!range) return null;
  const toMin = (
    hourRaw: string,
    minuteRaw: string | undefined,
    ampm: string,
  ) => {
    let hour = Number(hourRaw) % 12;
    if (/pm/i.test(ampm)) hour += 12;
    return hour * 60 + Number(minuteRaw ?? "0");
  };
  let duration =
    toMin(range[4], range[5], range[6]) - toMin(range[1], range[2], range[3]);
  if (duration < 0) duration += 24 * 60;
  return duration;
}

function isShortCryptoAsset(text: string, symbol?: string | null): boolean {
  const normalized = symbol?.trim().toUpperCase() ?? "";
  if ((SHORT_CRYPTO_SYMBOLS as readonly string[]).includes(normalized))
    return true;
  return (/BTCUSDT|\bBTC\b|Bitcoin/i.test(text) ||
    /ETHUSDT|\bETH\b|Ethereum/i.test(text) ||
    /BNBUSDT|\bBNB\b/i.test(text));
}

export type CryptoWindowKind = "5m" | "15m" | "1h" | "1d";

/** 1h/1d need a clearer move vs open than a 5m wick. */
export function windowMinVsStart(kind: CryptoWindowKind | null | undefined): number {
  if (kind === "1d") return 0.001;
  if (kind === "1h") return 0.0008;
  if (kind === "15m") return 0.0008;
  return 0.0005;
}

function isShortCryptoWindow(text: string): boolean {
  if (/\b4h\b/i.test(text)) return false;
  if (
    /\b1d\b/i.test(text) ||
    /\b1h\b/i.test(text) ||
    /\b15m\b/i.test(text) ||
    /\b5m\b/i.test(text)
  ) {
    return true;
  }
  const minutes = minutesBetweenClockRange(text);
  return minutes === 5 || minutes === 15 || minutes === 60 || minutes === 1_440;
}

export function cryptoWindowKind(options: {
  windowDurationSec?: number | null;
  title?: string | null;
}): CryptoWindowKind | null {
  const sec = options.windowDurationSec;
  if (sec != null && sec > 0) {
    if (sec <= 450) return "5m";
    if (sec <= 1_800) return "15m";
    if (sec <= 5_400) return "1h";
    if (sec <= 108_000) return "1d";
  }
  const text = options.title ?? "";
  if (/\b1d\b/i.test(text) || minutesBetweenClockRange(text) === 1_440) return "1d";
  if (/\b1h\b/i.test(text) || minutesBetweenClockRange(text) === 60) return "1h";
  if (/\b15m\b/i.test(text) || minutesBetweenClockRange(text) === 15) return "15m";
  if (/\b5m\b/i.test(text) || minutesBetweenClockRange(text) === 5) return "5m";
  return null;
}

/** 5m vs 15m contract length. Prefer start/end dates; fall back to "2PM-2:15PM" in the title. */
export function cryptoWindowDurationSec(options: {
  startDate?: Date | string | null;
  endDate?: Date | string | null;
  title?: string | null;
}): number | null {
  const start =
    options.startDate instanceof Date
      ? options.startDate.getTime()
      : typeof options.startDate === "string"
        ? new Date(options.startDate).getTime()
        : NaN;
  const end =
    options.endDate instanceof Date
      ? options.endDate.getTime()
      : typeof options.endDate === "string"
        ? new Date(options.endDate).getTime()
        : NaN;
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
    return Math.floor((end - start) / 1000);
  }
  const minutes = minutesBetweenClockRange(options.title ?? "");
  if (minutes != null && minutes > 0) return minutes * 60;
  const title = options.title ?? "";
  if (/\b1d\b/i.test(title)) return 86_400;
  if (/\b1h\b/i.test(title)) return 3_600;
  if (/\b15m\b/i.test(title)) return 900;
  if (/\b5m\b/i.test(title)) return 300;
  return null;
}

/** BTC / ETH / BNB Up or Down 5m, 15m, 1h and 1d — not 4h, SOL, sports, or stocks. */
export function isShortCryptoUpDownMarket(topic: ListedTopicLike): boolean {
  const text = topicSearchText(topic);
  if (!text) return false;
  return (
    isShortCryptoAsset(text, topic.symbol) &&
    /up or down/i.test(text) &&
    isShortCryptoWindow(text)
  );
}

export function isShortCryptoUpDownRow(market: {
  title?: string | null;
  question?: string | null;
  topic?: {
    title?: string | null;
    question?: string | null;
    symbol?: string | null;
  } | null;
}): boolean {
  return isShortCryptoUpDownMarket({
    title: [market.topic?.title, market.title].filter(Boolean).join(" "),
    question: market.topic?.question ?? market.question,
    symbol: market.topic?.symbol,
  });
}

export function shortCryptoUpDownMarketWhere(): Prisma.MarketWhereInput {
  const symbols = [...SHORT_CRYPTO_SYMBOLS];
  const assetOr: Prisma.MarketWhereInput[] = [
    { topic: { symbol: { in: symbols } } },
    { topic: { title: { contains: "BTC", mode: "insensitive" } } },
    { topic: { title: { contains: "ETH", mode: "insensitive" } } },
    { topic: { title: { contains: "BNB", mode: "insensitive" } } },
  ];
  const windowOr: Prisma.MarketWhereInput[] = [
    { topic: { title: { contains: "5m", mode: "insensitive" } } },
    { topic: { title: { contains: "15m", mode: "insensitive" } } },
    { topic: { title: { contains: "1h", mode: "insensitive" } } },
    { topic: { title: { contains: "1d", mode: "insensitive" } } },
    { title: { contains: "5m", mode: "insensitive" } },
    { title: { contains: "15m", mode: "insensitive" } },
    { title: { contains: "1h", mode: "insensitive" } },
    { title: { contains: "1d", mode: "insensitive" } },
  ];
  return {
    AND: [{ OR: assetOr }, { OR: windowOr }],
  };
}

/** Lower is better: 5m before 15m before 1h before 1d. */
export function cryptoUpDownPriority(topic: ListedTopicLike): number {
  if (!isShortCryptoUpDownMarket(topic)) return 100;
  const text = topicSearchText(topic);
  if (/\b5m\b/i.test(text)) return 0;
  if (/\b15m\b/i.test(text)) return 1;
  if (/\b1h\b/i.test(text)) return 2;
  if (/\b1d\b/i.test(text)) return 3;
  return 4;
}

export function pickDiscoveredTopics<T extends ListedTopicLike>(
  topics: T[],
  maxTopics: number,
): T[] {
  return topics
    .filter(isShortCryptoUpDownMarket)
    .sort((a, b) => {
      const rank = cryptoUpDownPriority(a) - cryptoUpDownPriority(b);
      if (rank !== 0) return rank;
      const left = asDate(a.endDate)?.getTime() ?? Number.POSITIVE_INFINITY;
      const right = asDate(b.endDate)?.getTime() ?? Number.POSITIVE_INFINITY;
      return left - right;
    })
    .slice(0, Math.max(0, maxTopics));
}

/**
 * Walk a page already sorted by END_DATE ASC. Skip expired / too-soon;
 * keep in-window; stop once the first too-far topic appears.
 */
export function selectHorizonTopics<T extends ListedTopicLike>(
  listed: T[],
  now: Date,
  minSec: number,
  maxSec: number,
): { keep: T[]; hitFar: boolean } {
  const keep: T[] = [];
  for (const topic of listed) {
    const kind = classifyEndDate(topic.endDate, now, minSec, maxSec);
    if (kind === "too_far") return { keep, hitFar: true };
    if (kind === "in_window") keep.push(topic);
  }
  return { keep, hitFar: false };
}

export function uniqueTopicsById<T extends ListedTopicLike>(topics: T[]): T[] {
  const byId = new Map<string, T>();
  for (const topic of topics) {
    const id = asId(topic.marketTopicId);
    if (!id) continue;
    byId.set(id, topic);
  }
  return [...byId.values()];
}

export function sortTopicsByEndDate<T extends ListedTopicLike>(
  topics: T[],
): T[] {
  return [...topics].sort((a, b) => {
    const left = asDate(a.endDate)?.getTime() ?? Number.POSITIVE_INFINITY;
    const right = asDate(b.endDate)?.getTime() ?? Number.POSITIVE_INFINITY;
    return left - right;
  });
}

export function tradableMarketWhere(now = new Date()): Prisma.MarketWhereInput {
  const horizon = collectorHorizon(now);
  return {
    AND: [
      {
        topic: {
          endDate: { gte: horizon.endDateGte, lte: horizon.endDateLte },
        },
      },
      shortCryptoUpDownMarketWhere(),
    ],
  };
}

export function tradableMarketQuery(now = new Date()): {
  where: Prisma.MarketWhereInput;
  orderBy: Prisma.MarketOrderByWithRelationInput;
  take: number;
} {
  return {
    where: tradableMarketWhere(now),
    orderBy: { topic: { endDate: "asc" } },
    take: env.COLLECTOR_MAX_TOPICS,
  };
}

/** Tradable 24h window, plus markets that still have OPEN positions (last 60s / expired ghosts). */
export function heldOrTradableMarketWhere(
  now = new Date(),
  held?: { mode?: "PAPER" | "LIVE" },
): Prisma.MarketWhereInput {
  return {
    OR: [
      tradableMarketWhere(now),
      {
        positions: {
          some: {
            status: "OPEN",
            ...(held?.mode ? { mode: held.mode } : {}),
          },
        },
      },
    ],
  };
}

export function heldOrTradableMarketQuery(
  now = new Date(),
  held?: { mode?: "PAPER" | "LIVE" },
): {
  where: Prisma.MarketWhereInput;
  orderBy: Prisma.MarketOrderByWithRelationInput;
  take: number;
} {
  return {
    where: heldOrTradableMarketWhere(now, held),
    orderBy: { topic: { endDate: "asc" } },
    take: env.COLLECTOR_MAX_TOPICS,
  };
}

export function marketHeadline(market: {
  title: string;
  question?: string | null;
}): string {
  const question = market.question?.trim();
  return question || market.title;
}
