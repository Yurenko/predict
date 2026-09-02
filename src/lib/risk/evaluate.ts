import { RiskEventType, SystemEventLevel, TradingMode } from "@prisma/client";
import type { RiskCheckResult } from "@/lib/types/domain";
import type { RiskDecision, RiskEventDraft, RiskIntent, RiskLimits, RiskSnapshot } from "@/lib/risk/types";
import { rollDailyWindow } from "@/lib/risk/state";

function check(
  name: string,
  passed: boolean,
  detail: string,
): RiskCheckResult {
  return { name, passed, detail };
}

function event(
  type: RiskEventType,
  message: string,
  severity: SystemEventLevel = SystemEventLevel.WARN,
): RiskEventDraft {
  return { type, severity, message };
}

function spreadBps(bid: number, ask: number): number {
  const mid = (bid + ask) / 2;
  if (!(mid > 0)) return Number.POSITIVE_INFINITY;
  return ((ask - bid) / mid) * 10_000;
}

function executablePrice(intent: RiskIntent): number | null {
  if (intent.action === "ENTER") return intent.bestAsk;
  return intent.bestBid;
}

function paperDemo(mode: TradingMode): boolean {
  return mode === TradingMode.PAPER;
}

/**
 * Pre-trade gate. EXIT is allowed under kill/stale/api/cooldown so the book
 * can flatten. LIVE is refused unless both live flags are on.
 * PAPER is a demo account: halt rails (kill, cooldown, stale, API breaker,
 * slippage, impact) do not block ENTER so strategies can be tested.
 */
export function evaluateRisk(
  intent: RiskIntent,
  state: RiskSnapshot,
  limits: RiskLimits,
): RiskDecision {
  const nextState = rollDailyWindow(state, intent.now);
  const checks: RiskCheckResult[] = [];
  const events: RiskEventDraft[] = [];
  const entry = intent.action === "ENTER";

  const liveOk = intent.mode !== TradingMode.LIVE || limits.liveTradingEnabled;
  checks.push(
    check(
      "live_gate",
      liveOk,
      liveOk
        ? `mode=${intent.mode}`
        : "LIVE requires LIVE_TRADING_ENABLED=true and TRADING_MODE=LIVE",
    ),
  );

  const bookOk = intent.bestBid !== null && intent.bestAsk !== null && intent.bestAsk > 0;
  checks.push(
    check(
      "executable_book",
      bookOk,
      bookOk ? "using bid/ask, not lastPrice" : "no executable bid/ask",
    ),
  );
  if (!bookOk) {
    events.push(event(RiskEventType.STALE_DATA, "missing executable book"));
  }

  if (intent.quoteExpireAt && intent.now.getTime() >= intent.quoteExpireAt.getTime()) {
    checks.push(check("quote_fresh", false, "quote expireAt is in the past"));
    events.push(event(RiskEventType.STALE_DATA, "quote expired"));
  } else {
    checks.push(check("quote_fresh", true, "quote not expired or absent"));
  }

  const exec = executablePrice(intent);
  if (
    bookOk &&
    exec !== null &&
    intent.proposedFillPrice !== null &&
    intent.proposedFillPrice !== undefined &&
    intent.lastPrice !== null &&
    Math.abs(intent.proposedFillPrice - intent.lastPrice) < 1e-12 &&
    Math.abs(intent.proposedFillPrice - exec) / exec * 10_000 > limits.maxSlippageBps
  ) {
    checks.push(check("not_last_price", false, "proposed fill equals lastPrice, not the book"));
    events.push(event(RiskEventType.ABNORMAL_FILL, "refusing lastPrice as executable"));
  } else {
    checks.push(check("not_last_price", true, "fill is not lastPrice"));
  }

  const demo = paperDemo(intent.mode);
  const killArmed = nextState.killSwitch;
  const killOk = !entry || !killArmed || demo;
  checks.push(
    check(
      "kill_switch",
      killOk,
      killArmed
        ? demo
          ? `paper ignores (${nextState.killSwitchReason ?? "armed"})`
          : (nextState.killSwitchReason ?? "armed")
        : "off",
    ),
  );
  if (!killOk) {
    events.push(
      event(RiskEventType.KILL_SWITCH, nextState.killSwitchReason ?? "kill switch armed", SystemEventLevel.ERROR),
    );
  }

  const cooling =
    nextState.cooldownUntil !== null && intent.now.getTime() < nextState.cooldownUntil.getTime();
  const cooldownOk = !entry || !cooling || demo;
  checks.push(
    check(
      "cooldown",
      cooldownOk,
      cooling
        ? demo
          ? `paper ignores until ${nextState.cooldownUntil?.toISOString()}`
          : `until ${nextState.cooldownUntil?.toISOString()}`
        : "clear",
    ),
  );
  if (!cooldownOk) {
    events.push(event(RiskEventType.COOLDOWN, "cooldown active"));
  }

  const staleByAge =
    intent.dataAgeMs !== null && intent.dataAgeMs > limits.staleMs;
  const stale = nextState.staleData || staleByAge;
  const staleOk = !entry || !stale || demo;
  checks.push(
    check(
      "stale_data",
      staleOk,
      stale
        ? demo
          ? `paper demo uses last book ageMs=${intent.dataAgeMs}`
          : `ageMs=${intent.dataAgeMs}`
        : "fresh",
    ),
  );
  if (!staleOk) {
    events.push(event(RiskEventType.STALE_DATA, "websocket or snapshot is stale"));
  }

  const apiOk = !entry || !nextState.apiErrorBreaker || demo;
  checks.push(check("api_breaker", apiOk, nextState.apiErrorBreaker ? "open" : "closed"));
  if (!apiOk) {
    events.push(event(RiskEventType.API_ERROR, "API error breaker is open"));
  }

  const sizeLimit = limits.bankrollUsdt * (limits.maxPositionPct / 100);
  const sizeOk = !entry || intent.requestedNotional <= sizeLimit + 1e-9;
  checks.push(
    check(
      "max_position_size",
      sizeOk,
      `requested ${intent.requestedNotional} vs max ${sizeLimit}`,
    ),
  );
  if (!sizeOk) {
    events.push(event(RiskEventType.MAX_POSITION_SIZE, "position notional exceeds maxPositionPct"));
  }

  const countOk = !entry || nextState.openPositions < limits.maxSimultaneousPositions;
  checks.push(
    check(
      "max_positions",
      countOk,
      `${nextState.openPositions}/${limits.maxSimultaneousPositions}`,
    ),
  );
  if (!countOk) {
    events.push(event(RiskEventType.MAX_EXPOSURE, "max simultaneous positions"));
  }

  const exposureOk =
    !entry || nextState.openNotional + intent.requestedNotional <= limits.bankrollUsdt + 1e-9;
  checks.push(
    check(
      "max_exposure",
      exposureOk,
      `open ${nextState.openNotional} + ${intent.requestedNotional} vs bankroll ${limits.bankrollUsdt}`,
    ),
  );
  if (!exposureOk) {
    events.push(event(RiskEventType.MAX_EXPOSURE, "total exposure exceeds bankroll"));
  }

  const tteMinOk =
    !entry ||
    intent.timeToExpirySec === null ||
    intent.timeToExpirySec >= limits.minTimeToExpirySec;
  checks.push(
    check(
      "min_time_to_expiry",
      tteMinOk,
      `${intent.timeToExpirySec}s vs min ${limits.minTimeToExpirySec}s`,
    ),
  );
  if (!tteMinOk) {
    events.push(event(RiskEventType.MIN_TIME_TO_EXPIRY, "too close to expiry"));
  }

  const tteMaxOk =
    !entry ||
    (intent.timeToExpirySec !== null &&
      intent.timeToExpirySec <= limits.maxTimeToExpirySec);
  checks.push(
    check(
      "max_time_to_expiry",
      tteMaxOk,
      intent.timeToExpirySec === null
        ? "expiry unknown — not treating as settling today"
        : `${intent.timeToExpirySec}s vs max ${limits.maxTimeToExpirySec}s`,
    ),
  );
  if (!tteMaxOk) {
    events.push(event(RiskEventType.MIN_TIME_TO_EXPIRY, "settlement is beyond the 24h horizon"));
  }

  const liqOk =
    !entry || (intent.liquidity !== null && intent.liquidity >= limits.minLiquidityUsdt);
  checks.push(
    check(
      "min_liquidity",
      liqOk,
      intent.liquidity === null
        ? "liquidity unknown — not treating as sufficient"
        : `${intent.liquidity} vs min ${limits.minLiquidityUsdt}`,
    ),
  );
  if (!liqOk) {
    events.push(event(RiskEventType.MIN_LIQUIDITY, "liquidity below minimum or unknown"));
  }

  const slip =
    intent.estimatedSlippageBps ??
    (bookOk ? spreadBps(intent.bestBid!, intent.bestAsk!) : null);
  const slipOk = !entry || slip === null || slip <= limits.maxSlippageBps || demo;
  checks.push(
    check(
      "max_slippage",
      slipOk,
      demo && slip !== null && slip > limits.maxSlippageBps
        ? `paper ignores slippageBps=${slip}`
        : `slippageBps=${slip}`,
    ),
  );
  if (!slipOk) {
    events.push(event(RiskEventType.MAX_SLIPPAGE, "slippage above cap"));
  }

  const impact = intent.estimatedPriceImpact ?? 0;
  const impactOk = !entry || impact <= limits.maxPriceImpact || demo;
  checks.push(check("max_price_impact", impactOk, `impact=${impact}`));
  if (!impactOk) {
    events.push(event(RiskEventType.MAX_PRICE_IMPACT, "price impact above cap"));
  }

  const allowed = checks.every((item) => item.passed);
  return {
    allowed,
    action: intent.action,
    checks,
    events,
    nextState,
  };
}
