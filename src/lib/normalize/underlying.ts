import { asDecimalString } from "@/lib/normalize/numbers";

export interface NormalizedUnderlyingSnapshot {
  symbol: string;
  observedAt: Date;
  price: string;
  bid: string | null;
  ask: string | null;
  volume: string | null;
  executable: false;
}

export function normalizeUnderlyingTicker(ticker: {
  symbol: string;
  price: number;
  bid?: number;
  ask?: number;
  volume?: number;
  eventTime: Date;
}): NormalizedUnderlyingSnapshot | null {
  const price = asDecimalString(ticker.price);
  if (!ticker.symbol || !price) return null;
  return {
    symbol: ticker.symbol.toUpperCase(),
    observedAt: ticker.eventTime,
    price,
    bid: asDecimalString(ticker.bid),
    ask: asDecimalString(ticker.ask),
    volume: asDecimalString(ticker.volume),
    executable: false,
  };
}
