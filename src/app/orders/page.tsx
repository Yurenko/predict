import { OrdersPanel } from "@/components/dashboard/live";
import { isLiveTradingEnabled } from "@/lib/config/env";

export default function OrdersPage() {
  const live = isLiveTradingEnabled();
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-6 py-10">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Ордери</h1>
        <p className="max-w-2xl text-sm leading-6 text-zinc-400">
          {live
            ? "LIVE-ордери: SUBMITTED одразу після placeOrder, FILLED після історії Binance. Не вдалий маркет (0 USDT) = FAILED. Список сторінками по 25."
            : "Paper-ордери з демо-рахунку ($1000 віртуально). FILLED = симуляція по книзі або getQuote, біржа не списує гроші. Kill / cooldown / slippage у paper більше не ріжуть вхід. Список сторінками по 25."}{" "}
          Кнопка очищення прибирає ордери, позиції й сигнали.
        </p>
      </header>
      <OrdersPanel />
    </main>
  );
}
