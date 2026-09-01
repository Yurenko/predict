import { OverviewPanel } from "@/components/dashboard/live";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-6 py-10">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Огляд</h1>
        <p className="max-w-2xl text-sm leading-6 text-zinc-400">
          Research dashboard читає Postgres і Redis. Секрети Binance на сервері.
          lastPrice не показується як executable. Live з UI не вмикається.
        </p>
      </header>
      <OverviewPanel />
    </main>
  );
}
