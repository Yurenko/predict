import { RiskPanel } from "@/components/dashboard/live";

export default function RiskPage() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-6 py-10">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Ризик</h1>
        <p className="max-w-2xl text-sm leading-6 text-zinc-400">
          Kill switch, cooldown, slippage і API breaker ріжуть лише LIVE.
          Paper їх ігнорує, щоб можна було тестити стратегії; розмір позиції й горизонт 24 год лишаються.
          Daily PnL обнуляється опівночі UTC; Equity нічний прибуток не втрачає.
          LIVE_TRADING_ENABLED тут змінити не можна.
        </p>
      </header>
      <RiskPanel />
    </main>
  );
}
