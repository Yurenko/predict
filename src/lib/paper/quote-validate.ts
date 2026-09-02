import { quoteHasExecutableCosts, type OfficialQuote } from "@/lib/binance/quote";
import { asNumber } from "@/lib/normalize/numbers";

export interface PaperQuote {
  quoteId: string;
  tokenId: string;
  averagePrice: number | null;
  lastPrice: number | null;
  chance: number | null;
  feeAmount: number | null;
  feeRateBps: number | null;
  slippageBps: number | null;
  priceImpact: number | null;
  minReceive: number | null;
  expireAt: Date | null;
}

export type QuoteValidation =
  | { ok: true; fillPrice: number; quote: PaperQuote }
  | { ok: false; reason: string };

function expireAtFromUnknown(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const n = asNumber(value);
  if (n === null) return null;
  const ms = n > 1_000_000_000_000 ? n : n * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Binance amountIn is wei (18 decimals). feeAmount may be wei or already decimal. */
export function feeAmountToUsdt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1_000_000 ? value / 1e18 : value;
  }
  if (typeof value === "string" && value.trim()) {
    if (!/^\d+(\.\d+)?$/.test(value.trim())) return null;
    if (value.trim().length >= 10 && !value.includes(".")) {
      const wei = Number(value);
      return Number.isFinite(wei) ? wei / 1e18 : null;
    }
    return asNumber(value);
  }
  return null;
}

export function paperQuoteFromOfficial(quote: OfficialQuote): PaperQuote {
  const quoteId = quote.quoteId;
  const tokenId = quote.tokenId;
  if (!quoteId || !tokenId) {
    throw new Error("GetQuoteResponse is missing quoteId or tokenId");
  }
  return {
    quoteId,
    tokenId,
    averagePrice: typeof quote.averagePrice === "number" ? quote.averagePrice : null,
    lastPrice: typeof quote.lastPrice === "number" ? quote.lastPrice : null,
    chance: asNumber(quote.chance),
    feeAmount: feeAmountToUsdt(quote.feeAmount),
    feeRateBps: typeof quote.feeRateBps === "number" ? quote.feeRateBps : null,
    slippageBps: typeof quote.slippageBps === "number" ? quote.slippageBps : null,
    priceImpact: typeof quote.priceImpact === "number" ? quote.priceImpact : null,
    minReceive: asNumber(quote.minReceive),
    expireAt: expireAtFromUnknown(quote.expireAt),
  };
}

/**
 * Executable price is quote.averagePrice or the book. lastPrice is never used.
 */
export function validateQuoteForFill(options: {
  quote: PaperQuote | null;
  side: "BUY" | "SELL";
  bestBid: number | null;
  bestAsk: number | null;
  lastPrice: number | null;
  now: Date;
}): QuoteValidation {
  const book = options.side === "BUY" ? options.bestAsk : options.bestBid;
  if (book === null || !(book > 0)) {
    return { ok: false, reason: "no_executable_book" };
  }

  const quote = options.quote;
  if (!quote) {
    return { ok: false, reason: "missing_quote" };
  }
  if (!quote.quoteId) {
    return { ok: false, reason: "missing_quote_id" };
  }
  if (quote.expireAt && options.now.getTime() >= quote.expireAt.getTime()) {
    return { ok: false, reason: "quote_expired" };
  }
  if (
    quote.feeAmount === null &&
    quote.feeRateBps === null
  ) {
    return { ok: false, reason: "missing_fee_data" };
  }

  const fillPrice = quote.averagePrice !== null && quote.averagePrice > 0 ? quote.averagePrice : book;
  if (
    options.lastPrice !== null &&
    Math.abs(fillPrice - options.lastPrice) < 1e-12 &&
    Math.abs(fillPrice - book) > 1e-9
  ) {
    return { ok: false, reason: "fill_is_last_price" };
  }

  return { ok: true, fillPrice, quote };
}

/** Last-book quote when official getQuote is missing. Demo account only. */
export function demoQuoteFromBook(options: {
  quoteId: string;
  tokenId: string;
  fillPrice: number;
  feeRateBps?: number;
}): PaperQuote {
  return {
    quoteId: options.quoteId,
    tokenId: options.tokenId,
    averagePrice: options.fillPrice,
    lastPrice: null,
    chance: options.fillPrice,
    feeAmount: null,
    feeRateBps: options.feeRateBps ?? 0,
    slippageBps: 0,
    priceImpact: 0,
    minReceive: null,
    expireAt: null,
  };
}

export function officialQuoteHasCosts(quote: OfficialQuote): boolean {
  return quoteHasExecutableCosts(quote);
}
