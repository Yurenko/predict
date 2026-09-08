import { OverviewPanel } from "@/components/dashboard/live";
import { RecordControls } from "@/components/dashboard/record";
import { isLiveTradingEnabled } from "@/lib/config/env";

export default function Home() {
  const live = isLiveTradingEnabled();
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-6 py-10">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Огляд</h1>
        <p className="max-w-2xl text-sm leading-6 text-zinc-400">
          {live
            ? "LIVE: ті самі Старт/Стоп і стратегії, що в paper. Після Старт ордери йдуть на біржу (placeOrder). Стоп зупиняє нові входи стратегій, не кнопку Закрити. Equity = закритий PnL + uPnL відкритих."
            : "Запис на віртуальному bankroll: сигнали й paper-ордери без списання реальних грошей. Binance placeOrder не викликається. Equity = закритий PnL + uPnL відкритих (якщо є книга)."}{" "}
          Очищення — кнопки біля Старт/Стоп.
        </p>
      </header>
      <RecordControls />
      <OverviewPanel />
    </main>
  );
}
