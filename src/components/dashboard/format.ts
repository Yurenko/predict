export function fmtNum(value: number | null | undefined, digits = 4): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
}

export function fmtUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function fmtPct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(2)}%`;
}

export function fmtTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("uk-UA", { hour12: false });
}

export function fmtRemaining(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "—";
  const ms = at - now;
  if (ms <= 0) return "закінчився";
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1_000))} с`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} хв`;
  if (ms < 86_400_000) {
    const hours = Math.floor(ms / 3_600_000);
    const mins = Math.round((ms % 3_600_000) / 60_000);
    return mins === 0 ? `${hours} год` : `${hours} год ${mins} хв`;
  }
  return `${Math.round(ms / 86_400_000)} д`;
}

export function fmtAge(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "—";
  const ms = Math.max(0, now - at);
  if (ms < 1_000) return `${ms} мс`;
  if (ms < 60_000) return `${Math.round(ms / 1_000)} с тому`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} хв тому`;
  return `${Math.round(ms / 3_600_000)} год тому`;
}

export function fmtDuration(fromIso: string | null | undefined, toIso?: string | null): string {
  if (!fromIso) return "—";
  const from = Date.parse(fromIso);
  if (!Number.isFinite(from)) return "—";
  const to = toIso ? Date.parse(toIso) : Date.now();
  if (!Number.isFinite(to)) return "—";
  const ms = Math.max(0, to - from);
  const totalSec = Math.floor(ms / 1_000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}хв ${sec}с`;
  return `${Math.floor(min / 60)}год ${min % 60}хв`;
}

export function pnlClass(value: number | null | undefined): string {
  if (value === null || value === undefined || value === 0) return "text-zinc-300";
  return value > 0 ? "text-emerald-400" : "text-rose-400";
}
