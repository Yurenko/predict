import { env, isLiveTradingEnabled } from "@/lib/config/env";
import { prisma } from "@/lib/db/prisma";
import { asNumber } from "@/lib/normalize/numbers";
import { collectorsAreFresh, loadCollectorHeartbeats } from "@/lib/observability/health";
import { assertNoSecrets, redactCredentialMentions } from "@/lib/dashboard/sanitize";
import { recordAccount, readRecordControl } from "@/lib/record/control";
import { isPidAlive, type RecordPayload, type RecordTickView } from "@/lib/record/types";

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function asSignals(value: unknown): RecordTickView["signals"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    return [
      {
        strategySlug: typeof row.strategySlug === "string" ? row.strategySlug : "unknown",
        direction: typeof row.direction === "string" ? row.direction : "FLAT",
        fairProbability: asNumber(row.fairProbability),
        netEdge: asNumber(row.netEdge) ?? 0,
        reason: typeof row.reason === "string" ? row.reason : "",
      },
    ];
  });
}

export function emptyRecordPayload(): RecordPayload {
  return {
    running: false,
    workerAlive: false,
    collecting: false,
    lastSampleAt: null,
    lastError: null,
    tradingMode: isLiveTradingEnabled() ? "LIVE" : "PAPER",
    liveTradingEnabled: isLiveTradingEnabled(),
    paper: null,
    account: recordAccount(),
    session: null,
    sessions: [],
    ticks: [],
    underlyings: [],
    collectors: [],
  };
}

export async function loadRecordPayload(): Promise<RecordPayload> {
  const payload = emptyRecordPayload();
  const control = await readRecordControl();
  payload.running = control.desired === "running";
  payload.workerAlive = isPidAlive(control.pid);
  payload.lastSampleAt = control.lastSampleAt;
  payload.lastError = control.lastError ? redactCredentialMentions(control.lastError) : null;
  payload.paper = control.paper
    ? {
        ...control.paper,
        skip: control.paper.skip ? redactCredentialMentions(control.paper.skip) : null,
      }
    : null;

  try {
    payload.collectors = await loadCollectorHeartbeats();
    payload.collecting = collectorsAreFresh(payload.collectors);
  } catch {
    payload.collectors = [];
  }

  try {
    const underlyings = await Promise.all(
      env.COLLECTOR_UNDERLYING_SYMBOLS.map(async (symbol) => {
        const row = await prisma.underlyingSnapshot.findFirst({
          where: { symbol },
          orderBy: { observedAt: "desc" },
        });
        return {
          symbol,
          price: asNumber(row?.price),
          observedAt: iso(row?.observedAt),
        };
      }),
    );
    payload.underlyings = underlyings;

    const sessions = await prisma.recordSession.findMany({
      orderBy: { startedAt: "desc" },
      take: 12,
    });
    payload.sessions = sessions.map((row) => ({
      id: row.id,
      status: row.status,
      startedAt: row.startedAt.toISOString(),
      stoppedAt: iso(row.stoppedAt),
      tickCount: row.tickCount,
      signalCount: row.signalCount,
      marketCount: row.marketCount,
      lastSampleAt: iso(row.lastSampleAt),
      error: row.error ? redactCredentialMentions(row.error) : null,
    }));
    const active =
      sessions.find((row) => row.status === "RUNNING") ?? sessions[0] ?? null;
    payload.session = active
      ? payload.sessions.find((row) => row.id === active.id) ?? null
      : null;

    if (active) {
      const ticks = await prisma.recordTick.findMany({
        where: { sessionId: active.id },
        orderBy: { observedAt: "desc" },
        take: 240,
      });
      payload.ticks = ticks.map(
        (row): RecordTickView => ({
          id: row.id,
          observedAt: row.observedAt.toISOString(),
          marketId: row.marketId,
          marketTitle: row.marketTitle,
          venueMarketId: row.venueMarketId,
          symbol: row.symbol,
          bestBid: asNumber(row.bestBid),
          bestAsk: asNumber(row.bestAsk),
          chance: asNumber(row.chance),
          lastPrice: asNumber(row.lastPrice),
          liquidity: asNumber(row.liquidity),
          spread: asNumber(row.spread),
          timeToExpirySec: row.timeToExpirySec,
          liveBook: row.liveBook,
          underlyingPrice: asNumber(row.underlyingPrice),
          underlyingReturn1m: asNumber(row.underlyingReturn1m),
          underlyingReturn5m: asNumber(row.underlyingReturn5m),
          underlyingReturn15m: asNumber(row.underlyingReturn15m),
          probabilityMean: asNumber(row.probabilityMean),
          probabilityStd: asNumber(row.probabilityStd),
          probabilityZ: asNumber(row.probabilityZ),
          signals: asSignals(row.signals),
        }),
      );
    }
  } catch {
    // database may be down; still return control + account
  }

  assertNoSecrets(payload);
  return payload;
}
