import pino from "pino";
import { env } from "@/lib/config/env";

export const logger = pino({
  level: env.LOG_LEVEL,
  base: {
    service: "bot-pol",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      "apiKey",
      "apiSecret",
      "secret",
      "BINANCE_PAPER_API_SECRET",
      "BINANCE_LIVE_API_SECRET",
      "*.apiKey",
      "*.apiSecret",
    ],
    remove: true,
  },
});

export function childLogger(bindings: {
  correlationId?: string;
  strategyId?: string;
  marketId?: string;
  orderId?: string;
  component?: string;
}) {
  return logger.child(bindings);
}
