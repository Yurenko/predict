import { OrdersPanel } from "@/components/dashboard/live";

export default function OrdersPage() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-6 py-10">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Ордери</h1>
        <p className="max-w-2xl text-sm leading-6 text-zinc-400">
          Paper ордери з ідемпотентністю. FAILED без quote — норма, поки немає wallet.
        </p>
      </header>
      <OrdersPanel />
    </main>
  );
}
