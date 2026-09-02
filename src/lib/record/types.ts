export const RECORD_CONTROL_KEY = "control:record";

export type RecordDesired = "running" | "stopped";

export interface RecordControl {
  desired: RecordDesired;
  sessionId: string | null;
  pid: number | null;
  lastSampleAt: string | null;
  lastError: string | null;
  spawnedAt: string | null;
  paper: RecordPaperCycle | null;
}

export interface RecordPaperCycle {
  at: string;
  enabled: number;
  considered: number;
  filled: number;
  skip: string | null;
}

export interface RecordHypotheticalSignal {
  strategySlug: string;
  direction: string;
  fairProbability: number | null;
  netEdge: number;
  reason: string;
}

export interface RecordTickView {
  id: string;
  observedAt: string;
  marketId: string;
  marketTitle: string;
  venueMarketId: string;
  symbol: string | null;
  bestBid: number | null;
  bestAsk: number | null;
  chance: number | null;
  lastPrice: number | null;
  liquidity: number | null;
  spread: number | null;
  timeToExpirySec: number | null;
  liveBook: boolean;
  underlyingPrice: number | null;
  underlyingReturn1m: number | null;
  underlyingReturn5m: number | null;
  underlyingReturn15m: number | null;
  probabilityMean: number | null;
  probabilityStd: number | null;
  probabilityZ: number | null;
  signals: RecordHypotheticalSignal[];
}

export interface RecordSessionView {
  id: string;
  status: string;
  startedAt: string;
  stoppedAt: string | null;
  tickCount: number;
  signalCount: number;
  marketCount: number;
  lastSampleAt: string | null;
  error: string | null;
}

export interface RecordAccountView {
  walletPreview: string | null;
  hasWallet: boolean;
  hasPaperKeys: boolean;
  bankrollUsdt: number;
  accountType: string;
}

export interface RecordUnderlyingView {
  symbol: string;
  price: number | null;
  observedAt: string | null;
}

export interface RecordPayload {
  running: boolean;
  workerAlive: boolean;
  collecting: boolean;
  lastSampleAt: string | null;
  lastError: string | null;
  paper: RecordPaperCycle | null;
  account: RecordAccountView;
  session: RecordSessionView | null;
  sessions: RecordSessionView[];
  ticks: RecordTickView[];
  underlyings: RecordUnderlyingView[];
  collectors: Array<{
    channel: string;
    lastAt: string | null;
    ageMs: number | null;
    stale: boolean;
  }>;
}

export function emptyRecordControl(): RecordControl {
  return {
    desired: "stopped",
    sessionId: null,
    pid: null,
    lastSampleAt: null,
    lastError: null,
    spawnedAt: null,
    paper: null,
  };
}

export function parseRecordControl(raw: string | null): RecordControl {
  if (!raw) return emptyRecordControl();
  try {
    const parsed = JSON.parse(raw) as Partial<RecordControl>;
    const paper =
      parsed.paper && typeof parsed.paper === "object"
        ? {
            at: typeof parsed.paper.at === "string" ? parsed.paper.at : "",
            enabled: typeof parsed.paper.enabled === "number" ? parsed.paper.enabled : 0,
            considered: typeof parsed.paper.considered === "number" ? parsed.paper.considered : 0,
            filled: typeof parsed.paper.filled === "number" ? parsed.paper.filled : 0,
            skip: typeof parsed.paper.skip === "string" ? parsed.paper.skip : null,
          }
        : null;
    return {
      desired: parsed.desired === "running" ? "running" : "stopped",
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : null,
      pid: typeof parsed.pid === "number" && Number.isFinite(parsed.pid) ? parsed.pid : null,
      lastSampleAt: typeof parsed.lastSampleAt === "string" ? parsed.lastSampleAt : null,
      lastError: typeof parsed.lastError === "string" ? parsed.lastError : null,
      spawnedAt: typeof parsed.spawnedAt === "string" ? parsed.spawnedAt : null,
      paper: paper && paper.at ? paper : null,
    };
  } catch {
    return emptyRecordControl();
  }
}

export function isPidAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function shouldKillExternalPid(controlPid: number | null, selfPid: number): boolean {
  return Boolean(controlPid && controlPid !== selfPid && isPidAlive(controlPid));
}

export function walletPreview(address: string): string | null {
  const trimmed = address.trim();
  if (!trimmed) return null;
  if (trimmed.length <= 12) return trimmed;
  return `${trimmed.slice(0, 6)}…${trimmed.slice(-4)}`;
}
