export type AlertSeverity = "info" | "warn" | "error";

export interface ObservabilityAlert {
  severity: AlertSeverity;
  code: string;
  message: string;
}

export interface AlertInput {
  database: "ok" | "error";
  redis: "ok" | "error";
  liveTradingEnabled: boolean;
  hasWallet: boolean;
  hasPaperKeys: boolean;
  hasLiveKeys: boolean;
  killSwitch: boolean;
  killSwitchReason: string | null;
  staleData: boolean;
  apiErrorBreaker: boolean;
  collectors: Array<{ channel: string; ageMs: number | null; stale: boolean }>;
}

export function deriveAlerts(input: AlertInput): ObservabilityAlert[] {
  const alerts: ObservabilityAlert[] = [];
  if (input.database === "error") {
    alerts.push({
      severity: "error",
      code: "database_down",
      message: "PostgreSQL is unreachable",
    });
  }
  if (input.redis === "error") {
    alerts.push({
      severity: "warn",
      code: "redis_down",
      message: "Redis is unreachable; live books and heartbeats are unavailable",
    });
  }
  if (input.killSwitch) {
    alerts.push({
      severity: "error",
      code: "kill_switch",
      message: input.killSwitchReason ?? "kill switch is armed; ENTER is blocked",
    });
  }
  if (input.staleData) {
    alerts.push({
      severity: "warn",
      code: "stale_data",
      message: "risk state marks market data as stale",
    });
  }
  if (input.apiErrorBreaker) {
    alerts.push({
      severity: "error",
      code: "api_breaker",
      message: "API error breaker is open",
    });
  }
  if (input.liveTradingEnabled) {
    alerts.push({
      severity: "warn",
      code: "live_flags_on",
      message: "LIVE_TRADING_ENABLED and TRADING_MODE=LIVE are both on",
    });
  }
  if (input.liveTradingEnabled && !input.hasLiveKeys) {
    alerts.push({
      severity: "error",
      code: "live_keys_missing",
      message: "live flags are on but BINANCE_LIVE_API_KEY/SECRET are missing; placeOrder will not run",
    });
  }
  if (!input.hasWallet || !input.hasPaperKeys) {
    alerts.push({
      severity: "info",
      code: "paper_quote_unready",
      message: "wallet or paper API keys missing; getQuote will not run",
    });
  }
  for (const collector of input.collectors) {
    if (collector.stale) {
      alerts.push({
        severity: "warn",
        code: "collector_stale",
        message: `${collector.channel} heartbeat is stale (${collector.ageMs ?? "unknown"}ms)`,
      });
    }
  }
  return alerts;
}
