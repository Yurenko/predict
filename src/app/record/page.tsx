import { RecordTapePanel } from "@/components/dashboard/record";

export default function RecordPage() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-6 py-10">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Запис live даних</h1>
        <p className="max-w-2xl text-sm leading-6 text-zinc-400">
          Live-стрічка цін і фіч. Paper-угоди (віртуальний рахунок, без placeOrder) — на Сигнали / Ордери /
          Позиції. Кнопка «Очистити стрічку запису» біля Старт/Стоп.
        </p>
      </header>
      <RecordTapePanel />
    </main>
  );
}
