import {
  NetworkError,
  RateLimitBanError,
  ServerError,
  TooManyRequestsError,
  W3WPrediction,
  type W3WPredictionRestAPI,
} from "@binance/w3w-prediction";
import { binanceCredentials, env, isLiveTradingEnabled } from "@/lib/config/env";
import { MinIntervalLimiter, withRetries } from "@/lib/binance/rate-limit";
import { mapOfficialQuote, type OfficialQuote } from "@/lib/binance/quote";

export type ListMarketsParams = W3WPredictionRestAPI.ListPredictionMarketsRequest;
export type GetQuoteParams = W3WPredictionRestAPI.GetQuoteRequest;
export type QueryOrderBookParams = W3WPredictionRestAPI.QueryOrderBookRequest;
export type PlaceOrderParams = W3WPredictionRestAPI.PlaceOrderRequest;
export type QueryOrderHistoryParams = W3WPredictionRestAPI.QueryOrderHistoryRequest;
export type QueryActiveOrdersParams = W3WPredictionRestAPI.QueryActiveOrdersRequest;

export interface BinancePredictionAdapter {
  listCategories(): Promise<W3WPredictionRestAPI.ListPredictionCategoriesResponse>;
  listMarkets(
    params?: ListMarketsParams,
  ): Promise<W3WPredictionRestAPI.ListPredictionMarketsResponse>;
  getMarketDetail(
    marketTopicId: string | number | bigint,
  ): Promise<W3WPredictionRestAPI.GetMarketDetailResponse>;
  searchMarkets(
    query: string,
    topK?: number,
  ): Promise<W3WPredictionRestAPI.MarketSearchResponse>;
  getOrderBook(
    params: QueryOrderBookParams,
  ): Promise<W3WPredictionRestAPI.QueryOrderBookResponse>;
  getLastTradePrice(
    marketId: string | number | bigint,
  ): Promise<W3WPredictionRestAPI.QueryLastTradePriceResponse>;
  getQuote(params: GetQuoteParams): Promise<OfficialQuote>;
  placeOrder(params: PlaceOrderParams): Promise<W3WPredictionRestAPI.PlaceOrderResponse>;
  queryOrderHistory(
    params: QueryOrderHistoryParams,
  ): Promise<W3WPredictionRestAPI.QueryOrderHistoryResponse>;
  queryActiveOrders(
    params: QueryActiveOrdersParams,
  ): Promise<W3WPredictionRestAPI.QueryActiveOrdersResponse>;
  listPredictionWallets(): Promise<W3WPredictionRestAPI.ListPredictionWalletsResponse>;
}

function toNumericId(value: string | number | bigint): number | bigint {
  if (typeof value === "number" || typeof value === "bigint") return value;
  if (!/^\d+$/.test(value)) {
    throw new Error(`id must be a positive integer, got ${value}`);
  }
  return value.length > 15 ? BigInt(value) : Number(value);
}

function isRetryable(error: unknown): boolean {
  return (
    error instanceof TooManyRequestsError ||
    error instanceof RateLimitBanError ||
    error instanceof NetworkError ||
    error instanceof ServerError
  );
}

export class OfficialPredictionAdapter implements BinancePredictionAdapter {
  constructor(
    private readonly client: W3WPrediction,
    private readonly limiter: MinIntervalLimiter,
  ) {}

  static fromEnv(): OfficialPredictionAdapter {
    const { apiKey, apiSecret } = binanceCredentials();
    if (!apiKey || !apiSecret) {
      throw new Error(
        isLiveTradingEnabled()
          ? "Binance prediction REST requires BINANCE_LIVE_API_KEY and BINANCE_LIVE_API_SECRET (signed SAPI)."
          : "Binance prediction REST requires BINANCE_PAPER_API_KEY and BINANCE_PAPER_API_SECRET (signed SAPI).",
      );
    }

    return new OfficialPredictionAdapter(
      new W3WPrediction({
        configurationRestAPI: {
          apiKey,
          apiSecret,
          basePath: env.BINANCE_PREDICTION_REST_BASE_URL,
          timeout: 15_000,
        },
      }),
      new MinIntervalLimiter(env.PREDICTION_MIN_REQUEST_INTERVAL_MS),
    );
  }

  listCategories() {
    return this.call(() => this.client.restAPI.listPredictionCategories());
  }

  listMarkets(params: ListMarketsParams = {}) {
    return this.call(() => this.client.restAPI.listPredictionMarkets(params));
  }

  getMarketDetail(marketTopicId: string | number | bigint) {
    return this.call(() =>
      this.client.restAPI.getMarketDetail({ marketTopicId: toNumericId(marketTopicId) }),
    );
  }

  searchMarkets(query: string, topK?: number) {
    return this.call(() => this.client.restAPI.marketSearch({ query, topK }));
  }

  getOrderBook(params: QueryOrderBookParams) {
    return this.call(() => this.client.restAPI.queryOrderBook(params));
  }

  getLastTradePrice(marketId: string | number | bigint) {
    return this.call(() =>
      this.client.restAPI.queryLastTradePrice({ marketId: toNumericId(marketId) }),
    );
  }

  async getQuote(params: GetQuoteParams): Promise<OfficialQuote> {
    if (params.feeRateBps !== undefined) {
      throw new Error(
        "Do not pass feeRateBps into getQuote; use the feeRateBps returned by Binance.",
      );
    }
    const data = await this.call(() => this.client.restAPI.getQuote(params));
    return mapOfficialQuote(data);
  }

  async placeOrder(params: PlaceOrderParams): Promise<W3WPredictionRestAPI.PlaceOrderResponse> {
    if (!isLiveTradingEnabled()) {
      throw new Error("placeOrder refused: LIVE_TRADING_ENABLED=true and TRADING_MODE=LIVE are required");
    }
    return this.call(() => this.client.restAPI.placeOrder(params));
  }

  queryOrderHistory(params: QueryOrderHistoryParams) {
    return this.call(() => this.client.restAPI.queryOrderHistory(params));
  }

  queryActiveOrders(params: QueryActiveOrdersParams) {
    return this.call(() => this.client.restAPI.queryActiveOrders(params));
  }

  listPredictionWallets() {
    return this.call(() => this.client.restAPI.listPredictionWallets());
  }

  private async call<T>(
    execute: () => Promise<{ data: () => Promise<T> }>,
  ): Promise<T> {
    return withRetries(
      async () => {
        await this.limiter.wait();
        const response = await execute();
        return response.data();
      },
      {
        isRetryable,
        delayMs: (attempt) => 2_000 * 2 ** (attempt - 1),
      },
    );
  }
}
