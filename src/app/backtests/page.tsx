import { BacktestsPanel } from "@/components/dashboard/live";

export default function BacktestsPage() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-6 py-10">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Бектести</h1>
        <p className="max-w-2xl text-sm leading-6 text-zinc-400">
          Replay історії prediction-книги з комісіями. Після Старт на Огляді з’являться знімки.
          Тут натисніть «Прогнати» — окремий термінал не потрібен.
        </p>
      </header>
      <BacktestsPanel />
    </main>
  );
}
