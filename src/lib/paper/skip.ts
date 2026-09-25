export const PAPER_SKIP = {
  noEnabledStrategies: "no_enabled_strategies",
  noPredictionBook: "no_prediction_book",
  noNearExpiry: "no_near_expiry",
  waitingNextHorizon: "waiting_next_horizon",
  noEntryYet: "no_entry_yet",
} as const;

const PAPER_SKIP_LABEL: Record<string, string> = {
  no_enabled_strategies: "немає увімкнених стратегій",
  no_prediction_book: "немає prediction ринків з книгою — paper не може відкрити віртуальну угоду",
  no_near_expiry:
    "немає BTC/ETH/BNB 5m, 15m, 1h або 1d Up/Down у вікні до експірі",
  waiting_next_horizon:
    "немає нових BTC/ETH/BNB 5m/15m/1h/1d у вікні — відкриті позиції ще в книзі, експірі закриє їх без нового ордера",
  no_entry_yet: "стратегії ще не дали вхід, або філ відхилено (див. Ордери)",
  missing_wallet_id: "немає walletId — перевірте BINANCE_PREDICTION_WALLET_ID і ADDRESS",
  live_adapter_unavailable: "live API ключі відсутні або невалідні",
};

export function paperSkipLabel(skip: string | null): string | null {
  if (!skip) return null;
  return PAPER_SKIP_LABEL[skip] ?? skip;
}
