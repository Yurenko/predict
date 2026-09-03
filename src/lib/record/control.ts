import { env, isLiveTradingEnabled } from "@/lib/config/env";
import { prisma } from "@/lib/db/prisma";
import { redis } from "@/lib/db/redis";
import { childLogger } from "@/lib/logger";
import { disarmKillSwitch } from "@/lib/risk/state";
import { loadRiskState, persistRiskSnapshot } from "@/lib/risk/persist";
import {
  RECORD_CONTROL_KEY,
  emptyRecordControl,
  isPidAlive,
  parseRecordControl,
  type RecordControl,
} from "@/lib/record/types";

const log = childLogger({ component: "record-control" });

async function readRaw(): Promise<RecordControl> {
  try {
    return parseRecordControl(await redis.get(RECORD_CONTROL_KEY));
  } catch (error) {
    log.warn({ err: String(error) }, "record control redis read failed");
    return emptyRecordControl();
  }
}

export async function readRecordControl(): Promise<RecordControl> {
  const control = await readRaw();
  if (control.pid && !isPidAlive(control.pid)) {
    return { ...control, pid: null };
  }
  return control;
}

export async function writeRecordControl(patch: Partial<RecordControl>): Promise<RecordControl> {
  const current = await readRaw();
  const next: RecordControl = { ...current, ...patch };
  try {
    await redis.set(RECORD_CONTROL_KEY, JSON.stringify(next));
  } catch (error) {
    log.warn({ err: String(error) }, "record control redis write failed");
  }
  return next;
}

export async function closeRunningSessions(reason?: string): Promise<void> {
  await prisma.recordSession.updateMany({
    where: { status: "RUNNING" },
    data: {
      status: "STOPPED",
      stoppedAt: new Date(),
      error: reason ?? null,
    },
  });
}

export async function startRecordSession(): Promise<{ control: RecordControl; sessionId: string }> {
  await closeRunningSessions("superseded");
  if (isLiveTradingEnabled()) {
    try {
      const state = await loadRiskState();
      if (state.killSwitch || state.cooldownUntil) {
        await persistRiskSnapshot(disarmKillSwitch(state));
        log.info("live Start: kill switch default off (arm from /risk when needed)");
      }
    } catch (error) {
      log.warn({ err: String(error) }, "live Start kill disarm skipped");
    }
  }
  const session = await prisma.recordSession.create({
    data: { status: "RUNNING" },
  });
  const control = await writeRecordControl({
    desired: "running",
    sessionId: session.id,
    lastError: null,
    lastSampleAt: null,
  });
  return { control, sessionId: session.id };
}

export async function stopRecordSession(): Promise<RecordControl> {
  const current = await readRaw();
  await closeRunningSessions();
  return writeRecordControl({
    desired: "stopped",
    sessionId: null,
    lastError: current.lastError,
  });
}

export async function touchRecordSample(options: {
  sessionId: string;
  tickCount: number;
  signalCount: number;
  marketCount: number;
  error?: string | null;
}): Promise<void> {
  const now = new Date();
  await prisma.recordSession.update({
    where: { id: options.sessionId },
    data: {
      tickCount: { increment: options.tickCount },
      signalCount: { increment: options.signalCount },
      marketCount: options.marketCount,
      lastSampleAt: now,
      error: options.error ?? null,
    },
  });
  await writeRecordControl({
    lastSampleAt: now.toISOString(),
    lastError: options.error ?? null,
    sessionId: options.sessionId,
  });
}

export function recordAccount() {
  return {
    walletPreview: walletPreviewSafe(env.BINANCE_PREDICTION_WALLET_ADDRESS),
    hasWallet: env.BINANCE_PREDICTION_WALLET_ADDRESS.trim().length > 0,
    hasPaperKeys: Boolean(env.BINANCE_PAPER_API_KEY && env.BINANCE_PAPER_API_SECRET),
    hasLiveKeys: Boolean(env.BINANCE_LIVE_API_KEY && env.BINANCE_LIVE_API_SECRET),
    bankrollUsdt: env.BANKROLL_USDT,
    accountType: env.BINANCE_PREDICTION_ACCOUNT_TYPE,
  };
}

function walletPreviewSafe(address: string) {
  const trimmed = address.trim();
  if (!trimmed) return null;
  if (trimmed.length <= 12) return trimmed;
  return `${trimmed.slice(0, 6)}…${trimmed.slice(-4)}`;
}
