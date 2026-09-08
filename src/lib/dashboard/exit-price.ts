import { asNumber } from "@/lib/normalize/numbers";

export function closePriceFromRaw(raw: unknown): number | null {
  if (!raw || typeof raw !== "object" || !("closePrice" in raw)) return null;
  return asNumber((raw as { closePrice: unknown }).closePrice);
}

/**
 * Fill price of the closing execution. OPEN has none.
 * A book SELL/BUY-back beats a later settlement 0 written into rawPayload.
 */
export function closedExitPrice(options: {
  status: string;
  executions?: Array<{ executedAt: Date | string; price: unknown }>;
  rawPayload?: unknown;
}): number | null {
  if (options.status === "OPEN") return null;
  const executions = [...(options.executions ?? [])].sort((a, b) => {
    return new Date(b.executedAt).getTime() - new Date(a.executedAt).getTime();
  });
  const latest = asNumber(executions[0]?.price);
  const stored = closePriceFromRaw(options.rawPayload);

  if (stored != null && stored > 0) return stored;
  if (executions.length >= 2 && latest != null && latest > 0) return latest;
  if (stored !== null) return stored;
  if (latest !== null) return latest;
  return null;
}
