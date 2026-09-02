import { binanceCredentials, env } from "@/lib/config/env";
import { ManagedWebSocket } from "@/lib/binance/ws-connection";
import {
  PREDICTION_ORDERBOOK_AGGREGATED_TOPIC,
  buildSapiWssUrl,
  parseOrderbookPayload,
  parseSapiEnvelope,
  sapiPingMessage,
  sapiSubscribeMessage,
  shouldApplyOrderbookUpdate,
  type PredictionOrderbookPayload,
} from "@/lib/binance/sapi-wss";
import { childLogger } from "@/lib/logger";

const log = childLogger({ component: "prediction-orderbook-ws" });

export interface PredictionRealtimeAdapter {
  subscribeAggregatedOrderBook(
    onBook: (book: PredictionOrderbookPayload) => Promise<void> | void,
    onStale?: (ageMs: number) => void,
  ): Promise<() => Promise<void>>;
}

/**
 * Official Binance SApi WSS orderbook stream.
 * URL carries the aggregated topic; after open we also send SUBSCRIBE + JSON PING.
 * @see https://developers.binance.com/en/docs/products/w3w-prediction/websocket-api/orderbook.md
 */
export class OfficialPredictionOrderbookWsAdapter implements PredictionRealtimeAdapter {
  private lastTsByMarket = new Map<number, number>();

  constructor(
    private readonly apiKey: string,
    private readonly apiSecret: string,
    private readonly baseUrl = env.BINANCE_PREDICTION_WSS_URL,
  ) {}

  static fromEnv(): OfficialPredictionOrderbookWsAdapter {
    const { apiKey, apiSecret } = binanceCredentials();
    if (!apiKey || !apiSecret) {
      throw new Error(
        "Prediction orderbook WebSocket is signed SApi WSS. Set BINANCE_PAPER_API_KEY and BINANCE_PAPER_API_SECRET.",
      );
    }
    return new OfficialPredictionOrderbookWsAdapter(apiKey, apiSecret);
  }

  async subscribeAggregatedOrderBook(
    onBook: (book: PredictionOrderbookPayload) => Promise<void> | void,
    onStale?: (ageMs: number) => void,
  ): Promise<() => Promise<void>> {
    this.lastTsByMarket.clear();
    const topic = PREDICTION_ORDERBOOK_AGGREGATED_TOPIC;

    const connection = new ManagedWebSocket({
      name: "prediction-orderbook",
      headers: { "X-MBX-APIKEY": this.apiKey },
      pingIntervalMs: 30_000,
      applicationPing: sapiPingMessage,
      staleMs: env.WS_STALE_MS,
      maxConnectionMs: env.WS_MAX_CONNECTION_MS,
      reconnectDelayMs: 3_000,
      urlFactory: () =>
        buildSapiWssUrl({
          baseUrl: this.baseUrl,
          apiSecret: this.apiSecret,
          topic,
        }).url,
      onOpen: (send) => {
        send(sapiSubscribeMessage(topic));
        log.info({ topic }, "sent SApi SUBSCRIBE for prediction orderbook");
      },
      onStale,
      extractObservedAt: (payload) => {
        const envelope = parseSapiEnvelope(payload);
        const book =
          parseOrderbookPayload(envelope?.data) ?? parseOrderbookPayload(payload);
        return book?.updateTimestampMs;
      },
      onMessage: async (payload) => {
        const envelope = parseSapiEnvelope(payload);
        if (!envelope) return;
        if (envelope.type === "COMMAND") {
          log.debug({ envelope }, "sapi command response");
          return;
        }
        const book =
          parseOrderbookPayload(envelope.data) ?? parseOrderbookPayload(payload);
        if (!book) {
          if (envelope.type && envelope.type !== "TOPIC") {
            log.info({ type: envelope.type }, "sapi websocket envelope ignored");
          }
          return;
        }

        const previous = this.lastTsByMarket.get(book.marketId);
        if (!shouldApplyOrderbookUpdate(previous, book.updateTimestampMs)) {
          return;
        }
        this.lastTsByMarket.set(book.marketId, book.updateTimestampMs);
        await onBook(book);
      },
    });

    connection.start();
    log.info({ topic }, "connecting aggregated prediction orderbook websocket");
    return () => connection.stop();
  }
}
