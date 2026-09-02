import { OverviewPanel } from "@/components/dashboard/live";
import { RecordControls } from "@/components/dashboard/record";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-6 py-10">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Огляд</h1>
        <p className="max-w-2xl text-sm leading-6 text-zinc-400">
          Запис на віртуальному bankroll: сигнали й paper-ордери без списання реальних грошей.
          Binance placeOrder не викликається. Equity = закритий PnL + uPnL відкритих (якщо є книга).
          Очищення — кнопки біля Старт/Стоп.
        </p>
      </header>
      <RecordControls />
      <OverviewPanel />
    </main>
  );
}
