import { TradingMode } from "@prisma/client";

export function assertPaperExecution(mode: TradingMode): void {
  if (mode === TradingMode.LIVE) {
    throw new Error("LIVE execution is not implemented in the paper worker; use npm run worker:live-exec");
  }
}
