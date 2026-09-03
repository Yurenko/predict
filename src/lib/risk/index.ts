export { evaluateRisk } from "@/lib/risk/evaluate";
export { limitsFromEnv, emptyRiskSnapshot } from "@/lib/risk/limits";
export {
  armKillSwitch,
  disarmKillSwitch,
  noteApiError,
  noteStaleData,
  recordClosedTrade,
  rollDailyWindow,
} from "@/lib/risk/state";
export { loadRiskState, persistRiskDecision, persistRiskSnapshot } from "@/lib/risk/persist";
export type {
  RiskAction,
  RiskDecision,
  RiskIntent,
  RiskLimits,
  RiskSnapshot,
} from "@/lib/risk/types";
