import type { PredictionOrderbookPayload } from "@/lib/binance/sapi-wss";
import { childLogger } from "@/lib/logger";

const log = childLogger({ component: "live-realtime-management" });

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
  } catch (error) {
    // The price collector must never be taken down by LIVE management,
    // but the failure must remain visible for LIVE diagnostics.
    log.error({ err: String(error), marketId: book.marketId }, "LIVE realtime management failed");
  }
}
