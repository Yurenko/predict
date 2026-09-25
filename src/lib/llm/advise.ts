import { env } from "@/lib/config/env";
import { childLogger } from "@/lib/logger";
import { invertBinaryPrice } from "@/lib/live/binary";
import {
  shouldStopLoss,
  shouldTakeProfit,
  stopLossReason,
  takeProfitReason,
} from "@/lib/live/take-profit";
import type { StrategyContext, StrategySignal } from "@/lib/types/domain";
import { cryptoWindowKind, windowMinVsStart, type CryptoWindowKind } from "@/lib/markets/horizon";

const log = childLogger({ component: "llm-advise" });

export type LlmAction = "HOLD" | "CLOSE" | "ENTER" | "SKIP";
export type LlmDirection = "up" | "down" | "unclear";

export interface LlmAdvice {
  action: LlmAction;
  direction: LlmDirection;
  reason: string;
}

export interface HeldLegAdvice {
  close: boolean;
  managementExit: boolean;
  reason: string | null;
  kind: "TAKE_PROFIT" | "STOP_LOSS" | "CANDLE_CLOSE" | "LLM_CLOSE" | null;
}

const cache = new Map<string, { at: number; advice: LlmAdvice }>();
let localProbe: { at: number; ok: boolean } | null = null;

export function isLocalLlmBaseUrl(raw = env.LLM_BASE_URL): boolean {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

export function llmConfigured(): boolean {
  if (env.LLM_API_KEY.trim().length > 0) return true;
  return isLocalLlmBaseUrl();
}

export async function llmAvailable(): Promise<boolean> {
  if (env.LLM_API_KEY.trim().length > 0) return true;
  if (!isLocalLlmBaseUrl()) return false;
  const now = Date.now();
  if (localProbe && now - localProbe.at < env.LLM_PROBE_MS) return localProbe.ok;
  try {
    const origin = new URL(env.LLM_BASE_URL).origin;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 800);
    try {
      const response = await fetch(`${origin}/api/tags`, { signal: controller.signal });
      if (!response.ok) {
        localProbe = { at: now, ok: false };
        return false;
      }
      const body = (await response.json()) as { models?: Array<{ name?: string }> };
      const wanted = env.LLM_MODEL.trim().toLowerCase();
      const wantedBase = wanted.split(":")[0];
      const names = (body.models ?? [])
        .map((row) => (row.name ?? "").toLowerCase())
        .filter(Boolean);
      const ok = names.some((name) => name === wanted || name.split(":")[0] === wantedBase);
      if (!ok) {
        log.warn({ model: env.LLM_MODEL, have: names.slice(0, 8) }, "ollama missing model");
      }
      localProbe = { at: now, ok };
      return ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    localProbe = { at: now, ok: false };
    return false;
  }
}

export function parseLlmAdvice(raw: string): LlmAdvice | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    const action = parsed.action;
    if (action !== "HOLD" && action !== "CLOSE" && action !== "ENTER" && action !== "SKIP") {
      return null;
    }
    const direction =
      parsed.direction === "up" || parsed.direction === "down" || parsed.direction === "unclear"
        ? parsed.direction
        : "unclear";
    const reason = typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : action;
    return { action, direction, reason };
  } catch {
    return null;
  }
}

function sideFromDown(isDown: boolean): Exclude<LlmDirection, "unclear"> {
  return isDown ? "down" : "up";
}

/** Spot vs this window's open. Null = too close to call. */
export function candleSide(options: {
  underlyingOpen: number | null | undefined;
  underlyingNow: number | null | undefined;
  minVsStart?: number;
}): "up" | "down" | null {
  const open = options.underlyingOpen;
  const now = options.underlyingNow;
  const min = options.minVsStart ?? 0.0005;
  if (open == null || now == null || !(open > 0)) return null;
  const vs = (now - open) / open;
  if (vs >= min) return "up";
  if (vs <= -min) return "down";
  return null;
}

function isVacuousReason(reason: string): boolean {
  const text = reason.trim().toLowerCase();
  return (
    text === "short" ||
    text === "profit" ||
    text === "hold" ||
    text === "close" ||
    text === "enter" ||
    text === "skip"
  );
}

export function edgeInBand(
  netEdge: number | null | undefined,
  min = env.EDGE_MIN,
  max = env.EDGE_MAX,
): boolean {
  if (netEdge == null || !Number.isFinite(netEdge)) return false;
  return netEdge >= min && netEdge <= max;
}

export function signalTokenSide(
  direction: StrategySignal["direction"] | null | undefined,
): "up" | "down" | null {
  if (direction === "BUY") return "up";
  if (direction === "SELL") return "down";
  return null;
}

/**
 * Enter only when signal, candle and LLM all pick the same token and net edge is inside the band.
 * A missing LLM is a skip — signals alone must not trade.
 */
export function decideEntryAdvice(options: {
  proposedDown: boolean;
  advice: LlmAdvice | null;
  underlyingOpen?: number | null;
  underlyingNow?: number | null;
  netEdge?: number | null;
  edgeMin?: number;
  edgeMax?: number;
}): { allow: boolean; reason: string | null } {
  const proposed = sideFromDown(options.proposedDown);
  const candle = candleSide({
    underlyingOpen: options.underlyingOpen,
    underlyingNow: options.underlyingNow,
  });
  const min = options.edgeMin ?? env.EDGE_MIN;
  const max = options.edgeMax ?? env.EDGE_MAX;
  if (!edgeInBand(options.netEdge, min, max)) {
    return {
      allow: false,
      reason: `skip: netEdge ${options.netEdge == null ? "n/a" : options.netEdge.toFixed(3)} outside ${min}-${max}`,
    };
  }
  if (!candle) {
    return { allow: false, reason: "skip: candle unclear vs open" };
  }
  if (candle !== proposed) {
    return { allow: false, reason: `skip: signal ${proposed} vs candle ${candle}` };
  }
  const advice = options.advice;
  if (!advice) {
    return { allow: false, reason: "skip: llm missing (need signal+llm+candle)" };
  }
  if (advice.action !== "ENTER") {
    return { allow: false, reason: `skip: llm ${advice.action}${advice.reason ? ` ${advice.reason}` : ""}` };
  }
  if (advice.direction !== proposed) {
    return { allow: false, reason: `skip: llm ${advice.direction} vs signal ${proposed}` };
  }
  if (isVacuousReason(advice.reason) && advice.direction === "unclear") {
    return { allow: false, reason: "skip: llm unclear" };
  }
  return { allow: true, reason: advice.reason };
}

/**
 * Cut a held token when spot vs open has clearly flipped. Do not wait for LLM —
 * 1h/1d BUY Up otherwise sits until settlement 0.
 */
export function decideHeldAdvice(options: {
  isDown: boolean;
  underlyingOpen?: number | null;
  underlyingNow?: number | null;
  minVsStart?: number;
}): { close: boolean; reason: string | null; kind: HeldLegAdvice["kind"] } {
  const held = sideFromDown(options.isDown);
  const candle = candleSide({
    underlyingOpen: options.underlyingOpen,
    underlyingNow: options.underlyingNow,
    minVsStart: options.minVsStart,
  });
  if (candle != null && candle !== held) {
    return {
      close: true,
      kind: "CANDLE_CLOSE",
      reason: `candle-close: held ${held} vs candle ${candle}`,
    };
  }
  return { close: false, kind: null, reason: candle ? `hold: candle still ${candle}` : "hold: candle unclear vs open" };
}

export function heldContractMark(options: {
  isDown: boolean;
  bestBid: number | null;
  bestAsk: number | null;
}): number | null {
  return options.isDown ? invertBinaryPrice(options.bestAsk) : options.bestBid;
}

export function managementCloseSignal(options: {
  strategyId: string;
  marketId: string;
  now: Date;
  reason: string;
  chance?: number | null;
}): StrategySignal {
  const probability = options.chance ?? 0.5;
  return {
    strategyId: options.strategyId,
    marketId: options.marketId,
    timestamp: options.now,
    direction: "EXIT",
    marketProbability: probability,
    fairProbability: probability,
    grossEdge: 0,
    estimatedFees: 0,
    estimatedSlippage: 0,
    estimatedPriceImpact: 0,
    netEdge: 0,
    confidence: 1,
    reason: options.reason,
    riskChecks: [],
  };
}

function windowKind(ctx: StrategyContext): CryptoWindowKind {
  return cryptoWindowKind({ windowDurationSec: ctx.windowDurationSec }) ?? "5m";
}

export function heldAdvicePrompt(input: {
  window: CryptoWindowKind;
  heldSide: "Up" | "Down";
  signalSide: "up" | "down" | "exit" | "flat" | "none";
  candleSide: "up" | "down" | "unclear";
  netEdge: number | null;
  edgeMin: number;
  edgeMax: number;
  contractEntry: number;
  contractMark: number;
  underlyingOpen: number | null;
  underlyingNow: number | null;
  timeToExpirySec: number | null;
  return2m: number | null;
  return5m: number | null;
  return15m: number | null;
}): string {
  return [
    "Confirm or skip. Do not override the signal.",
    "We BUY a binary token. BUY Up owns Up (wins if underlyingNow >= underlyingOpen). BUY Down owns Down (wins if now < open).",
    "contractEntry/contractMark are token prices 0..1, not the coin.",
    "CLOSE if candleSide is the opposite of heldSide. HOLD if the candle still matches heldSide or is unclear.",
    "Never CLOSE a losing mark as profit.",
    "Copy candleSide and signalSide from the JSON. Do not invent the opposite.",
    "Reply JSON only: {\"action\":\"HOLD\"|\"CLOSE\",\"direction\":\"up\"|\"down\"|\"unclear\",\"reason\":\"agree\"}",
    JSON.stringify(input),
  ].join("\n");
}

export function entryAdvicePrompt(input: {
  window: CryptoWindowKind;
  signalSide: "Up" | "Down";
  candleSide: "up" | "down" | "unclear";
  netEdge: number | null;
  edgeMin: number;
  edgeMax: number;
  ask: number | null;
  underlyingOpen: number | null;
  underlyingNow: number | null;
  timeToExpirySec: number | null;
  return2m: number | null;
  return5m: number | null;
  return15m: number | null;
}): string {
  return [
    "Confirm or skip. Do not override the signal.",
    "signalSide is the token the strategy wants to BUY. candleSide is underlyingNow vs underlyingOpen.",
    "ENTER only if signalSide == candleSide == your direction AND edgeMin <= netEdge <= edgeMax.",
    "Otherwise SKIP. Do not invent a side. BUY Down is buying the Down token, not shorting the coin.",
    "Copy candleSide and signalSide from the JSON. Do not invent the opposite or a fake edge.",
    "Reply JSON only: {\"action\":\"ENTER\"|\"SKIP\",\"direction\":\"up\"|\"down\"|\"unclear\",\"reason\":\"agree\"}",
    JSON.stringify(input),
  ].join("\n");
}

async function completeJson(prompt: string, cacheKey: string): Promise<LlmAdvice | null> {
  if (!(await llmAvailable())) return null;
  const now = Date.now();
  const hit = cache.get(cacheKey);
  if (hit && now - hit.at < env.LLM_CACHE_MS) return hit.advice;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.LLM_TIMEOUT_MS);
  try {
    const url = `${env.LLM_BASE_URL.replace(/\/$/, "")}/chat/completions`;
    const headers: Record<string, string> = { "content-type": "application/json" };
    const key = env.LLM_API_KEY.trim();
    if (key) headers.authorization = `Bearer ${key}`;
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers,
      body: JSON.stringify({
        model: env.LLM_MODEL,
        temperature: 0,
        messages: [
          { role: "system", content: "Return only compact JSON. No markdown." },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!response.ok) {
      log.warn({ status: response.status }, "llm http failed");
      return null;
    }
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = body.choices?.[0]?.message?.content ?? "";
    const advice = parseLlmAdvice(text);
    if (!advice) {
      log.warn({ text: text.slice(0, 200) }, "llm parse failed");
      return null;
    }
    cache.set(cacheKey, { at: now, advice });
    return advice;
  } catch (error) {
    log.warn({ err: String(error) }, "llm request failed");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function adviseHeldPosition(options: {
  positionId: string;
  strategyId: string;
  marketId: string;
  now: Date;
  isDown: boolean;
  entryPrice: number;
  ctx: StrategyContext;
  signal: StrategySignal | null;
  edgeMin?: number;
  edgeMax?: number;
}): Promise<HeldLegAdvice> {
  const mark = heldContractMark({
    isDown: options.isDown,
    bestBid: options.ctx.bestBid,
    bestAsk: options.ctx.bestAsk,
  });
  if (
    mark != null &&
    shouldTakeProfit({
      entryPrice: options.entryPrice,
      currentPrice: mark,
      timeToExpirySec: options.ctx.timeToExpirySec,
      takeProfitMark: env.TAKE_PROFIT_MARK,
      takeProfitMinDelta: env.TAKE_PROFIT_MIN_DELTA,
      minTteSec: env.TAKE_PROFIT_MIN_TTE_SEC,
    })
  ) {
    return {
      close: true,
      managementExit: true,
      kind: "TAKE_PROFIT",
      reason: takeProfitReason(options.entryPrice, mark),
    };
  }

  if (
    mark != null &&
    shouldStopLoss({
      entryPrice: options.entryPrice,
      currentPrice: mark,
      stopLossDelta: env.STOP_LOSS_DELTA,
      stopLossMark: env.STOP_LOSS_MARK,
    })
  ) {
    return {
      close: true,
      managementExit: true,
      kind: "STOP_LOSS",
      reason: stopLossReason(options.entryPrice, mark),
    };
  }

  if (mark == null) {
    return { close: false, managementExit: false, kind: null, reason: null };
  }

  void options.signal;
  void options.edgeMin;
  void options.edgeMax;
  const decided = decideHeldAdvice({
    isDown: options.isDown,
    underlyingOpen: options.ctx.startPrice,
    underlyingNow: options.ctx.underlyingPrice,
    minVsStart: windowMinVsStart(windowKind(options.ctx)),
  });
  if (decided.close && decided.reason) {
    return {
      close: true,
      managementExit: true,
      kind: decided.kind,
      reason: decided.reason,
    };
  }
  return { close: false, managementExit: false, kind: null, reason: decided.reason };
}

export async function adviseEntryAllowed(options: {
  marketId: string;
  proposedDown: boolean;
  ctx: StrategyContext;
  netEdge: number | null;
  edgeMin?: number;
  edgeMax?: number;
}): Promise<{ allow: boolean; reason: string | null }> {
  const candle = candleSide({
    underlyingOpen: options.ctx.startPrice,
    underlyingNow: options.ctx.underlyingPrice,
  });
  const edgeMin = options.edgeMin ?? env.EDGE_MIN;
  const edgeMax = options.edgeMax ?? env.EDGE_MAX;
  const gated = decideEntryAdvice({
    proposedDown: options.proposedDown,
    advice: { action: "ENTER", direction: options.proposedDown ? "down" : "up", reason: "precheck" },
    underlyingOpen: options.ctx.startPrice,
    underlyingNow: options.ctx.underlyingPrice,
    netEdge: options.netEdge,
    edgeMin,
    edgeMax,
  });
  if (!gated.allow) {
    return gated;
  }
  let advice = null;
  if (await llmAvailable()) {
    const prompt = entryAdvicePrompt({
      window: windowKind(options.ctx),
      signalSide: options.proposedDown ? "Down" : "Up",
      candleSide: candle ?? "unclear",
      netEdge: options.netEdge,
      edgeMin,
      edgeMax,
      ask: options.proposedDown ? invertBinaryPrice(options.ctx.bestBid) : options.ctx.bestAsk,
      underlyingOpen: options.ctx.startPrice,
      underlyingNow: options.ctx.underlyingPrice,
      timeToExpirySec: options.ctx.timeToExpirySec,
      return2m: options.ctx.features.underlyingReturn2m,
      return5m: options.ctx.features.underlyingReturn5m,
      return15m: options.ctx.features.underlyingReturn15m,
    });
    advice = await completeJson(
      prompt,
      `enter:${options.marketId}:${options.proposedDown ? "d" : "u"}:${options.netEdge?.toFixed(3) ?? "na"}:${candle ?? "na"}`,
    );
  }
  return decideEntryAdvice({
    proposedDown: options.proposedDown,
    advice,
    underlyingOpen: options.ctx.startPrice,
    underlyingNow: options.ctx.underlyingPrice,
    netEdge: options.netEdge,
    edgeMin,
    edgeMax,
  });
}
