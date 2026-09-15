import type { PredictionOrderbookPayload } from "@/lib/binance/sapi-wss";

export type LiveRealtimeManagementHandler = (
  book: PredictionOrderbookPayload,
) => Promise<void> | void;

let handler: LiveRealtimeManagementHandler | null = null;

/**
 * Registers the LIVE position-management callback used by the prediction
 * orderbook WebSocket. The callback is deliberately separate from the
 * collector so the collector stays useful for recording/PAPER mode too.
 */
export function registerLiveRealtimeManagementHandler(
  next: LiveRealtimeManagementHandler | null,
): void {
  handler = next;
}

export async function notifyLiveRealtimeManagement(
  book: PredictionOrderbookPayload,
): Promise<void> {
  if (!handler) return;
  try {
    await handler(book);
  } catch {
    // The price collector must never be taken down by LIVE management.
  }
}
