import { RiskPanel } from "@/components/dashboard/live";

export default function RiskPage() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-6 py-10">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Ризик</h1>
        <p className="max-w-2xl text-sm leading-6 text-zinc-400">
          Kill switch за замовчуванням вимкнений і не блокує LIVE. Увімкни його на цій сторінці,
          лише коли треба заморозити нові входи. Paper його ігнорує. Cooldown, stale і API breaker
          LIVE ENTER теж не ріжуть. Розмір позиції й горизонт 24 год лишаються.
          Daily PnL обнуляється опівночі UTC; Equity нічний прибуток не втрачає.
          LIVE_TRADING_ENABLED тут змінити не можна (локально: `npm run dev:live`).
        </p>
      </header>
      <RiskPanel />
    </main>
  );
}
