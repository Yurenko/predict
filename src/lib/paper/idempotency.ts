import { createHash } from "node:crypto";
import { TradingMode } from "@prisma/client";
import { stableStringify } from "@/lib/binance/payload";

export function paperIdempotencyKey(parts: {
  mode: TradingMode;
  strategyId: string;
  marketId: string;
  tokenId: string;
  side: string;
  action: string;
  bucketMs: number;
  extra?: string;
}): string {
  const payload = stableStringify({
    mode: parts.mode,
    strategyId: parts.strategyId,
    marketId: parts.marketId,
    tokenId: parts.tokenId,
    side: parts.side,
    action: parts.action,
    bucket: parts.bucketMs,
    extra: parts.extra ?? "",
  });
  return createHash("sha256").update(payload).digest("hex");
}

export function clientOrderIdFromKey(idempotencyKey: string, prefix = "paper"): string {
  return `${prefix}-${idempotencyKey.slice(0, 24)}`;
}

export function timeBucket(now: Date, windowMs: number): number {
  return Math.floor(now.getTime() / windowMs);
}
