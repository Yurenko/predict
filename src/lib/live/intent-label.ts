import { outcomeIsDownToken } from "@/lib/normalize/markets";

/** BUY opens UP, SELL opens DOWN, EXIT names the side being closed. */
export function signalIntentLabel(options: {
  direction: string;
  outcomeName?: string | null;
}): string {
  const direction = options.direction.toUpperCase();
  if (direction === "BUY") return "BUY UP";
  if (direction === "SELL") return "BUY DOWN";
  if (direction === "EXIT") {
    if (outcomeIsDownToken(options.outcomeName)) return "EXIT SELL";
    if (options.outcomeName?.trim()) return "EXIT BUY";
    return "EXIT";
  }
  return options.direction;
}

export function exitIntentFromOutcome(outcomeName?: string | null): "EXIT BUY" | "EXIT SELL" {
  return outcomeIsDownToken(outcomeName) ? "EXIT SELL" : "EXIT BUY";
}

/**
 * LIVE order row: BUY = open Up/Down. SELL fill = EXIT of that token
 * (never a naked short), even if reconcile dropped rawPayload.intent.
 */
export function orderIntentLabel(options: {
  side: string;
  outcomeName?: string | null;
  intent?: string | null;
  action?: string | null;
}): string {
  const intent = options.intent?.trim() || options.action?.trim();
  if (intent === "EXIT BUY" || intent === "EXIT SELL") return intent;
  if (intent === "EXIT" || options.action === "EXIT" || options.side === "SELL") {
    return exitIntentFromOutcome(options.outcomeName);
  }
  if (options.side === "BUY") {
    return outcomeIsDownToken(options.outcomeName) ? "BUY DOWN" : "BUY UP";
  }
  const token = options.outcomeName?.trim();
  if (!token) return options.side;
  return `${options.side} ${token}`;
}

/** SUBMITTED LIMIT with filled=0 must show the requested flatten, not $0.00. */
export function orderNotionalUsd(options: {
  status: string;
  filledUsdtAmount: number | null | undefined;
  requestedAmount: number;
}): number {
  const filled = options.filledUsdtAmount;
  const requested = Number.isFinite(options.requestedAmount) ? options.requestedAmount : 0;
  if (
    (options.status === "FILLED" || options.status === "PARTIALLY_FILLED") &&
    filled != null &&
    Number.isFinite(filled)
  ) {
    return filled;
  }
  return requested;
}
