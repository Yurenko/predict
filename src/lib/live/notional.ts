export const LIVE_MIN_ORDER_USDT = 1;
/** Extra USDT kept back so a $2 ticket does not bounce on dust/fees. */
export const LIVE_ENTER_USDT_BUFFER = 0.05;
/** Ignore prediction-orderbook WS older than this when sizing EXIT — stale bid undersizes SELL. ENTER still uses the last book. */
export const LIVE_BOOK_MAX_AGE_MS = 8_000;

export function isFreshLiveBook(dataAgeMs: number | null | undefined): boolean {
  if (dataAgeMs == null || !Number.isFinite(dataAgeMs) || dataAgeMs < 0) return false;
  return dataAgeMs <= LIVE_BOOK_MAX_AGE_MS;
}

export function maxLiveEnterNotional(limits: {
  bankrollUsdt: number;
  maxPositionPct: number;
}): number {
  return limits.bankrollUsdt * (limits.maxPositionPct / 100);
}

function finitePrice(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value < 0) return null;
  return value;
}

/**
 * Conservative = bid (long) / ask (short): never asks Binance for more shares than we hold.
 * Aggressive = max(bid, ask, last, avg) capped at 1: SELL USDT is amount/fillPrice shares,
 * so a stale low bid leaves leftover (BUY $2 @ 0.74 → SELL $1.70 @ 0.87 → 0.72 shares).
 */
export function liveFlattenExitPrice(options: {
  positionSide: "BUY" | "SELL";
  bestBid: number | null;
  bestAsk: number | null;
  lastPrice: number | null;
  avgPrice: number;
  aggressive: boolean;
}): number {
  const bid = finitePrice(options.bestBid);
  const ask = finitePrice(options.bestAsk);
  const last = finitePrice(options.lastPrice);
  const avg = Math.max(0, options.avgPrice);
  const conservative =
    options.positionSide === "BUY" ? (bid ?? avg) : (ask ?? avg);
  if (!options.aggressive) return conservative;
  const aggressive = Math.max(conservative, bid ?? 0, ask ?? 0, last ?? 0, avg);
  return Math.min(1, aggressive);
}

/** Opposite-side mark for a flatten, same as the paper worker. */
export function liveExitMark(options: {
  positionSide: "BUY" | "SELL";
  bestBid: number | null;
  bestAsk: number | null;
  avgPrice: number;
}): number {
  const mark =
    options.positionSide === "BUY" ? options.bestBid : options.bestAsk;
  if (mark != null && Number.isFinite(mark) && mark >= 0) return mark;
  return options.avgPrice;
}

/**
 * USDT to send on EXIT: leftover shares × mark only.
 * Never size from original totalCost — that oversells after a partial fill
 * and Binance returns "exceeded your available shares".
 * venueTradableShares from ONGOING wins; 0 means nothing left to sell.
 */
export function liveFlattenNotional(options: {
  localShares: number;
  venueTradableShares?: number | null;
  exitPrice: number;
  avgPrice: number;
  totalCost?: number;
}): { shares: number; notional: number } {
  const local = Number.isFinite(options.localShares) ? Math.max(0, options.localShares) : 0;
  const venue =
    options.venueTradableShares != null && Number.isFinite(options.venueTradableShares)
      ? Math.max(0, options.venueTradableShares)
      : null;
  const shares = venue != null ? venue : local;
  const px =
    Number.isFinite(options.exitPrice) && options.exitPrice > 0
      ? options.exitPrice
      : options.avgPrice;
  const notional = shares * Math.max(0, px);
  return { shares, notional };
}

/** Binance rejects a SELL quote bigger than wallet inventory. */
export function liveExitExceedsInventory(quotedUsdt: number, heldNotional: number): boolean {
  if (!(quotedUsdt > 0) || !(heldNotional >= 0)) return false;
  return quotedUsdt > heldNotional * 1.02 + 1e-9;
}

export function maxLiveOrderNotional(options: {
  action: "ENTER" | "EXIT";
  bankrollUsdt: number;
  maxPositionPct: number;
}): number {
  if (options.action === "EXIT") return Number.POSITIVE_INFINITY;
  return maxLiveEnterNotional(options);
}

/** Clip ENTER to bankroll × maxPositionPct. EXIT stays the full requested flatten. */
export function clipLiveOrderNotional(options: {
  action: "ENTER" | "EXIT";
  requested: number;
  bankrollUsdt: number;
  maxPositionPct: number;
}): number {
  if (!Number.isFinite(options.requested) || options.requested <= 0) return 0;
  if (options.action === "EXIT") return options.requested;
  return Math.min(options.requested, maxLiveEnterNotional(options));
}

/**
 * SELL getQuote amountIn is shares, not USDT. shares × price is only for the
 * dashboard requested notional. Sending USDT as amountIn sells that many shares
 * (BUY $2 @ 0.83 → SELL $1.18 treated as 1.18 shares → ~$0.56 fill).
 */
export function liveExitSellNotionals(options: {
  shares: number;
  bestBid: number | null;
  bestAsk: number | null;
  lastPrice: number | null;
  avgPrice: number;
}): number[] {
  const shares = Number.isFinite(options.shares) ? Math.max(0, options.shares) : 0;
  if (!(shares > 0)) return [];
  const aggressive = liveFlattenExitPrice({
    positionSide: "BUY",
    bestBid: options.bestBid,
    bestAsk: options.bestAsk,
    lastPrice: options.lastPrice,
    avgPrice: options.avgPrice,
    aggressive: true,
  });
  const conservative = liveFlattenExitPrice({
    positionSide: "BUY",
    bestBid: options.bestBid,
    bestAsk: options.bestAsk,
    lastPrice: options.lastPrice,
    avgPrice: options.avgPrice,
    aggressive: false,
  });
  const raw = [
    shares * conservative,
    shares * ((aggressive + conservative) / 2),
    shares * aggressive,
  ];
  const seen = new Set<string>();
  const out: number[] = [];
  for (const value of raw) {
    if (!Number.isFinite(value) || !(value > 0)) continue;
    const key = value.toFixed(4);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/** Fail-closed: unknown balance cannot ENTER. EXIT is decided elsewhere. */
export function canLiveEnterNotional(
  availableUsdt: number | null | undefined,
  requested: number,
  buffer = LIVE_ENTER_USDT_BUFFER,
): boolean {
  if (availableUsdt == null || !Number.isFinite(availableUsdt)) return false;
  if (!Number.isFinite(requested) || !(requested > 0)) return false;
  return availableUsdt + 1e-9 >= requested + Math.max(0, buffer);
}

/** USDT that sells exactly `shares` at this fill — never more, or FOK leftovers. */
export function liveExitCoverNotional(shares: number, fillPrice: number): number {
  if (!(shares > 0) || !(fillPrice > 0) || !Number.isFinite(shares) || !Number.isFinite(fillPrice)) {
    return 0;
  }
  return shares * fillPrice;
}
