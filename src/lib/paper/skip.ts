export const PAPER_SKIP = {
  noEnabledStrategies: "no_enabled_strategies",
  noPredictionBook: "no_prediction_book",
  noNearExpiry: "no_near_expiry",
  noEntryYet: "no_entry_yet",
} as const;

const PAPER_SKIP_LABEL: Record<string, string> = {
  no_enabled_strategies: "немає увімкнених стратегій",
  no_prediction_book: "немає prediction ринків з книгою — paper не може відкрити віртуальну угоду",
  no_near_expiry:
    "немає ринків, що закриваються протягом 24 год (спорт сьогодні, 5m Up/Down, live)",
  no_entry_yet: "стратегії ще не дали вхід, або філ відхилено (див. Ордери)",
};

export function paperSkipLabel(skip: string | null): string | null {
  if (!skip) return null;
  return PAPER_SKIP_LABEL[skip] ?? skip;
}
