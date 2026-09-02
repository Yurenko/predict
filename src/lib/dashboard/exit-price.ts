import { asNumber } from "@/lib/normalize/numbers";

export function closePriceFromRaw(raw: unknown): number | null {
  if (!raw || typeof raw !== "object" || !("closePrice" in raw)) return null;
  return asNumber((raw as { closePrice: unknown }).closePrice);
}

/**
 * Fill price of the closing execution. OPEN has none.
 * Latest execution on a CLOSED row is the EXIT (entry is earlier).
 */
export function closedExitPrice(options: {
  status: string;
  executions?: Array<{ executedAt: Date | string; price: unknown }>;
  rawPayload?: unknown;
}): number | null {
  if (options.status === "OPEN") return null;
  const stored = closePriceFromRaw(options.rawPayload);
  if (stored !== null) return stored;
  const executions = [...(options.executions ?? [])].sort((a, b) => {
    const at = new Date(b.executedAt).getTime() - new Date(a.executedAt).getTime();
    return at;
  });
  if (executions.length >= 2) return asNumber(executions[0]?.price);
  if (executions.length === 1) return asNumber(executions[0]?.price);
  return null;
}
