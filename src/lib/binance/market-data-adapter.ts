import { env } from "@/lib/config/env";
import { ManagedWebSocket } from "@/lib/binance/ws-connection";
import { childLogger } from "@/lib/logger";

export interface UnderlyingTicker {
  symbol: string;
  price: number;
  bid?: number;
  ask?: number;
  volume?: number;
  eventTime: Date;
  /** lastPrice / ticker close is not an executable prediction quote. */
  executable: false;
  raw: unknown;
}

export interface BinanceMarketDataAdapter {
  getTicker(symbol: string): Promise<UnderlyingTicker>;
  subscribeTickers(
    symbols: string[],
    onMessage: (ticker: UnderlyingTicker) => Promise<void> | void,
    onStale?: (ageMs: number) => void,
  ): Promise<() => Promise<void>>;
}

const log = childLogger({ component: "spot-market-data" });

interface SpotTicker24h {
  symbol: string;
  lastPrice: string;
  bidPrice?: string;
  askPrice?: string;
  volume?: string;
  closeTime?: number;
}

interface SpotWsTicker {
  e?: string;
  E?: number;
  s?: string;
  c?: string;
  b?: string;
  a?: string;
  v?: string;
}

function asNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function mapRestTicker(data: SpotTicker24h): UnderlyingTicker {
  const price = asNumber(data.lastPrice);
  if (!price) {
    throw new Error(`Spot 24hr ticker missing lastPrice for ${data.symbol}`);
  }
  return {
    symbol: data.symbol,
    price,
    bid: asNumber(data.bidPrice),
    ask: asNumber(data.askPrice),
    volume: asNumber(data.volume),
    eventTime: data.closeTime ? new Date(data.closeTime) : new Date(),
    executable: false,
    raw: data,
  };
}

function mapWsTicker(data: SpotWsTicker): UnderlyingTicker | null {
  const price = asNumber(data.c);
  if (!data.s || !price) return null;
  return {
    symbol: data.s,
    price,
    bid: asNumber(data.b),
    ask: asNumber(data.a),
    volume: asNumber(data.v),
    eventTime: data.E ? new Date(data.E) : new Date(),
    executable: false,
    raw: data,
  };
}

export class OfficialSpotMarketDataAdapter implements BinanceMarketDataAdapter {
  constructor(
    private readonly restBaseUrl = env.BINANCE_SPOT_REST_BASE_URL,
    private readonly wsBaseUrl = env.BINANCE_SPOT_WS_BASE_URL,
  ) {}

  async getTicker(symbol: string): Promise<UnderlyingTicker> {
    const url = `${this.restBaseUrl}/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbol)}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Spot ticker HTTP ${response.status} for ${symbol}`);
    }
    const data = (await response.json()) as SpotTicker24h;
    return mapRestTicker(data);
  }

  async subscribeTickers(
    symbols: string[],
    onMessage: (ticker: UnderlyingTicker) => Promise<void> | void,
    onStale?: (ageMs: number) => void,
  ): Promise<() => Promise<void>> {
    const streams = symbols
      .map((symbol) => `${symbol.toLowerCase()}@ticker`)
      .join("/");
    const url = `${this.wsBaseUrl}/stream?streams=${streams}`;

    const connection = new ManagedWebSocket({
      name: "spot-ticker",
      url,
      staleMs: env.WS_STALE_MS,
      maxConnectionMs: env.WS_MAX_CONNECTION_MS,
      onStale,
      extractObservedAt: (payload) => {
        const wrapped = payload as { data?: SpotWsTicker };
        return wrapped.data?.E ?? (payload as SpotWsTicker).E;
      },
      onMessage: async (payload) => {
        const wrapped = payload as { stream?: string; data?: SpotWsTicker };
        const ticker = mapWsTicker(wrapped.data ?? (payload as SpotWsTicker));
        if (!ticker) {
          log.warn({ payload: wrapped.stream }, "ignored non-ticker websocket payload");
          return;
        }
        await onMessage(ticker);
      },
    });

    connection.start();
    return () => connection.stop();
  }
}
