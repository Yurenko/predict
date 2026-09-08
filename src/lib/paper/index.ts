export { executePaperTrade, resetPaperIdempotencyCache, skippedPaperTrade } from "@/lib/paper/engine";
export type { PaperBook, PaperExecutionStage, PaperTradeRequest, PaperTradeResult } from "@/lib/paper/engine";
export {
  PAPER_FILL_DELAY_MS,
  PAPER_SETTLEMENT_DELAY_MS,
  paperFillReady,
  paperSettleAt,
  paperSettlementReady,
} from "@/lib/paper/delays";
export { persistPaperTrade } from "@/lib/paper/persist";
export {
  flattenExpiredPositions,
  flattenExpiredPaperPositions,
  expiryExitPrice,
  settlementFill,
} from "@/lib/paper/expiry";
export { closePaperPosition, manualCloseSignal, manualExitPrice } from "@/lib/paper/close";
export { decidePaperAction, isDuplicatePaperEnter, paperExitPnl, paperOrderSide } from "@/lib/paper/action";
export type { PaperAction } from "@/lib/paper/action";
export {
  DEFAULT_PAPER_ENTRY_MODE,
  parsePaperEntryMode,
  readPaperEntryMode,
  shouldSkipPeerEnter,
  writePaperEntryMode,
} from "@/lib/paper/entry-mode";
export type { PaperEntryMode } from "@/lib/paper/entry-mode";
export { quoteAmountInWei, toWei, usdtToWei } from "@/lib/paper/amounts";
export { fetchOfficialPaperQuote, fetchOfficialPaperQuoteResult, hasPredictionWallet } from "@/lib/paper/fetch-quote";
export {
  parsePaperCycle,
  readPaperCycle,
  writePaperCycle,
  newerPaperCycle,
} from "@/lib/paper/cycle";
export { paperSkipLabel, PAPER_SKIP } from "@/lib/paper/skip";
export type { PaperCycle } from "@/lib/paper/cycle";
export { assertPaperExecution } from "@/lib/paper/live-gate";
export {
  paperQuoteFromOfficial,
  validateQuoteForFill,
} from "@/lib/paper/quote-validate";
export type { PaperQuote } from "@/lib/paper/quote-validate";
