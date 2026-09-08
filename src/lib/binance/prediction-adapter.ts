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
import { buildSapiSignedQuery } from "@/lib/binance/sapi-wss";

export type ListMarketsParams = W3WPredictionRestAPI.ListPredictionMarketsRequest;
export type GetQuoteParams = W3WPredictionRestAPI.GetQuoteRequest;
export type QueryOrderBookParams = W3WPredictionRestAPI.QueryOrderBookRequest;
export type PlaceOrderParams = W3WPredictionRestAPI.PlaceOrderRequest;
export type QueryOrderHistoryParams = W3WPredictionRestAPI.QueryOrderHistoryRequest;
export type QueryActiveOrdersParams = W3WPredictionRestAPI.QueryActiveOrdersRequest;
export type QueryPositionsParams = W3WPredictionRestAPI.QueryPositionsRequest;
export type QuerySettledPositionHistoryParams =
  W3WPredictionRestAPI.QuerySettledPositionHistoryRequest;
export type BatchRedeemParams = W3WPredictionRestAPI.BatchRedeemRequest;
export type GetRedeemStatusParams = W3WPredictionRestAPI.GetRedeemStatusRequest;

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
  queryPositions(
    params: QueryPositionsParams,
  ): Promise<W3WPredictionRestAPI.QueryPositionsResponse>;
  querySettledPositionHistory(
    params: QuerySettledPositionHistoryParams,
  ): Promise<W3WPredictionRestAPI.QuerySettledPositionHistoryResponse>;
  batchRedeem(params: BatchRedeemParams): Promise<W3WPredictionRestAPI.BatchRedeemResponse>;
  getRedeemStatus(
    params: GetRedeemStatusParams,
  ): Promise<W3WPredictionRestAPI.GetRedeemStatusResponse>;
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

  queryPositions(params: QueryPositionsParams) {
    return this.call(() => this.client.restAPI.queryPositions(params));
  }

  querySettledPositionHistory(params: QuerySettledPositionHistoryParams) {
    return this.call(() => this.client.restAPI.querySettledPositionHistory(params));
  }

  async batchRedeem(params: BatchRedeemParams): Promise<W3WPredictionRestAPI.BatchRedeemResponse> {
    if (!isLiveTradingEnabled()) {
      throw new Error("batchRedeem refused: LIVE_TRADING_ENABLED=true and TRADING_MODE=LIVE are required");
    }
    return this.call(async () => {
      const { apiKey, apiSecret } = binanceCredentials();
      if (!apiKey || !apiSecret) {
        throw new Error("batchRedeem refused: live API credentials are missing");
      }
      const pairs: Array<[string, string]> = [
        ["walletAddress", params.walletAddress],
        ["walletId", params.walletId],
        ["chainId", params.chainId ?? env.BINANCE_PREDICTION_CHAIN_ID],
      ];
      for (const tokenId of params.tokenIds) {
        if (tokenId) pairs.push(["tokenIds", tokenId]);
      }
      const { query } = buildSapiSignedQuery({ apiSecret, pairs });
      const url = `${env.BINANCE_PREDICTION_REST_BASE_URL.replace(/\/$/, "")}/sapi/v1/w3w/wallet/prediction/batch-redeem?${query}`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "X-MBX-APIKEY": apiKey },
      });
      const body = (await response.json()) as W3WPredictionRestAPI.BatchRedeemResponse & {
        code?: number;
        msg?: string;
      };
      if (!response.ok || (body.code != null && body.code !== 0 && !body.batchId && !body.results)) {
        throw new Error(`batchRedeem ${response.status}: ${body.msg ?? body.code ?? "failed"}`);
      }
      return { data: async () => body };
    });
  }

  getRedeemStatus(params: GetRedeemStatusParams) {
    return this.call(() => this.client.restAPI.getRedeemStatus(params));
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
