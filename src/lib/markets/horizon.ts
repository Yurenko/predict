import type { Prisma } from "@prisma/client";
import { env } from "@/lib/config/env";
import { asDate, asId } from "@/lib/normalize/numbers";

export const DAY_SEC = 86_400;
export const LIST_PAGE_SIZE = 100;
export const LIST_MAX_PAGES = 5;

export type HorizonClass = "expired" | "too_soon" | "in_window" | "too_far" | "unknown";

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

export interface ListedTopicLike {
  marketTopicId?: number | bigint | string;
  endDate?: number | bigint | string | Date | null;
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

export function sortTopicsByEndDate<T extends ListedTopicLike>(topics: T[]): T[] {
  return [...topics].sort((a, b) => {
    const left = asDate(a.endDate)?.getTime() ?? Number.POSITIVE_INFINITY;
    const right = asDate(b.endDate)?.getTime() ?? Number.POSITIVE_INFINITY;
    return left - right;
  });
}

export function tradableMarketWhere(now = new Date()): Prisma.MarketWhereInput {
  const horizon = collectorHorizon(now);
  return {
    topic: {
      endDate: { gte: horizon.endDateGte, lte: horizon.endDateLte },
    },
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

export function marketHeadline(market: {
  title: string;
  question?: string | null;
}): string {
  const question = market.question?.trim();
  return question || market.title;
}
