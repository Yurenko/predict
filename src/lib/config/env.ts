import "dotenv/config";
import { z } from "zod";

const booleanFromString = z
  .union([z.boolean(), z.string()])
  .transform((value) => {
    if (typeof value === "boolean") return value;
    return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  });

const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1)
    .default("postgresql://botpol:botpol@localhost:5432/botpol?schema=public"),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  LIVE_TRADING_ENABLED: booleanFromString.default(false),
  TRADING_MODE: z.enum(["PAPER", "LIVE"]).default("PAPER"),
  BINANCE_PAPER_API_KEY: z.string().optional().default(""),
  BINANCE_PAPER_API_SECRET: z.string().optional().default(""),
  BINANCE_LIVE_API_KEY: z.string().optional().default(""),
  BINANCE_LIVE_API_SECRET: z.string().optional().default(""),
  BINANCE_SPOT_REST_BASE_URL: z
    .string()
    .default("https://api.binance.com"),
  BINANCE_SPOT_WS_BASE_URL: z
    .string()
    .default("wss://stream.binance.com:9443"),
  BINANCE_PREDICTION_REST_BASE_URL: z
    .string()
    .default("https://api.binance.com"),
  BINANCE_PREDICTION_WSS_URL: z.string().default("wss://api.binance.com/sapi/wss"),
  BINANCE_PREDICTION_CHAIN_ID: z.string().default("56"),
  BINANCE_PREDICTION_WALLET_ADDRESS: z.string().optional().default(""),
  BINANCE_PREDICTION_WALLET_ID: z.string().optional().default(""),
  BINANCE_PREDICTION_ACCOUNT_TYPE: z.enum(["SPOT", "FUNDING"]).default("SPOT"),
  PREDICTION_MIN_REQUEST_INTERVAL_MS: z.coerce.number().int().positive().default(4000),
  COLLECTOR_L1_CATEGORY: z.string().default(""),
  COLLECTOR_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  COLLECTOR_REST_DISCOVERY_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  COLLECTOR_WS_PERSIST_MIN_INTERVAL_MS: z.coerce.number().int().positive().default(1_000),
  COLLECTOR_MAX_TOPICS: z.coerce.number().int().positive().default(20),
  COLLECTOR_MAX_TIME_TO_EXPIRY_SEC: z.coerce.number().int().positive().default(86_400),
  COLLECTOR_UNDERLYING_SYMBOLS: z
    .string()
    .default("BTCUSDT,ETHUSDT,BNBUSDT")
    .transform((value) =>
      value
        .split(",")
        .map((symbol) => symbol.trim().toUpperCase())
        .filter(Boolean),
    ),
  COLLECTOR_ONCE: booleanFromString.default(false),
  WS_STALE_MS: z.coerce.number().int().positive().default(15_000),
  WS_MAX_CONNECTION_MS: z.coerce.number().int().positive().default(82_800_000),
  RAW_DATA_DIR: z.string().default("./data/raw"),
  RAW_FILE_PERSIST_MODE: z.enum(["always", "fallback", "off"]).default("fallback"),
  RAW_FILE_MAX_TOTAL_BYTES: z.coerce.number().int().positive().default(512 * 1024 * 1024),
  RAW_FILE_RETENTION_DAYS: z.coerce.number().int().positive().default(2),
  RAW_FILE_CLEANUP_INTERVAL_MS: z.coerce.number().int().positive().default(15 * 60_000),
  RAW_FILE_MIN_FREE_BYTES: z.coerce.number().int().positive().default(2 * 1024 * 1024 * 1024),
  BANKROLL_USDT: z.coerce.number().positive().default(1000),
  MAX_POSITION_PCT: z.coerce.number().positive().default(5),
  MAX_SIMULTANEOUS_POSITIONS: z.coerce.number().int().positive().default(5),
  MAX_DAILY_LOSS_PCT: z.coerce.number().positive().default(3),
  MAX_DRAWDOWN_PCT: z.coerce.number().positive().default(10),
  MAX_SLIPPAGE_BPS: z.coerce.number().int().nonnegative().default(1000),
  MAX_PRICE_IMPACT: z.coerce.number().nonnegative().default(0.05),
  MIN_LIQUIDITY_USDT: z.coerce.number().nonnegative().default(100),
  MIN_TIME_TO_EXPIRY_SEC: z.coerce.number().int().nonnegative().default(60),
  SAFETY_MARGIN: z.coerce.number().nonnegative().default(0.005),
  MAX_ENTRY_ASK: z.coerce.number().min(0).max(1).default(0.75),
  RISK_COOLDOWN_MS: z.coerce.number().int().nonnegative().default(900_000),
  RISK_CONSECUTIVE_LOSSES: z.coerce.number().int().positive().default(5),
  PAPER_LOOP_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
  RECORD_LOOP_INTERVAL_MS: z.coerce.number().int().positive().default(2_000),
  PAPER_IDEMPOTENCY_MS: z.coerce.number().int().positive().default(5_000),
  LIVE_LOOP_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
  LIVE_IDEMPOTENCY_MS: z.coerce.number().int().positive().default(5_000),
  LIVE_BINARY_MODE: z.preprocess(
    (value) => (value === "" || value == null ? undefined : value),
    z.enum(["independent", "flip"]).optional(),
  ),
  LIVE_INFLIGHT_STALE_MS: z.coerce.number().int().positive().default(120_000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type AppEnv = z.infer<typeof envSchema>;

function loadEnv(): AppEnv {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }

  const env = parsed.data;
  const liveRequested = env.LIVE_TRADING_ENABLED && env.TRADING_MODE === "LIVE";

  return {
    ...env,
    LIVE_TRADING_ENABLED: liveRequested,
    TRADING_MODE: liveRequested ? "LIVE" : "PAPER",
  };
}

export const env = loadEnv();

export function isLiveTradingEnabled(): boolean {
  return env.LIVE_TRADING_ENABLED && env.TRADING_MODE === "LIVE";
}

export function binanceCredentials(): { apiKey: string; apiSecret: string } {
  if (isLiveTradingEnabled()) {
    return {
      apiKey: env.BINANCE_LIVE_API_KEY,
      apiSecret: env.BINANCE_LIVE_API_SECRET,
    };
  }

  return {
    apiKey: env.BINANCE_PAPER_API_KEY,
    apiSecret: env.BINANCE_PAPER_API_SECRET,
  };
}
