import { SignalsPanel } from "@/components/dashboard/live";

export default function SignalsPage() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-6 py-10">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Сигнали</h1>
        <p className="max-w-2xl text-sm leading-6 text-zinc-400">
          evaluate() → Signal. Accepted = так після демо-FILLED (віртуальний рахунок). Реальних грошей немає.
          Список сторінками по 25. Очищення на цій сторінці також скидає позиції й ордери.
        </p>
      </header>
      <SignalsPanel />
    </main>
  );
}
