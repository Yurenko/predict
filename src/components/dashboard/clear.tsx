"use client";

import { useState } from "react";

export const DASHBOARD_RESET_EVENT = "botpol-dashboard-reset";

const COPY: Record<"paper" | "record", { label: string; confirm: string }> = {
  paper: {
    label: "Очистити позиції / ордери / сигнали",
    confirm:
      "Видалити локальні позиції, ордери і сигнали (paper і LIVE) і скинути equity? Спочатку Стоп. Угоди на Binance не скасовуються — лише книга бота. Ринки й стрічка Запису залишаться.",
  },
  record: {
    label: "Очистити стрічку запису",
    confirm:
      "Видалити всі сесії й тіки на вкладці Запис? Позиції не чіпаємо. Якщо сесія ще крутиться — спочатку Стоп.",
  },
};

function resetErrorText(code: string): string {
  if (code === "stop_first") return "Спочатку Стоп, потім очищення";
  if (code === "reset failed") return "Очищення не вдалося — перевірте логи воркера";
  return code;
}

export function ClearDataButtons({
  scopes,
  onDone,
}: {
  scopes: Array<"paper" | "record">;
  onDone?: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(scope: "paper" | "record") {
    if (!window.confirm(COPY[scope].confirm)) return;
    setBusy(scope);
    setError(null);
    try {
      const response = await fetch("/api/dashboard/reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope }),
      });
      if (!response.ok) {
        const json = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(resetErrorText(json?.error ?? `HTTP ${response.status}`));
      }
      window.dispatchEvent(new Event(DASHBOARD_RESET_EVENT));
      await onDone?.();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {scopes.map((scope) => (
        <button
          key={scope}
          type="button"
          disabled={busy !== null}
          onClick={() => void run(scope)}
          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
        >
          {busy === scope ? "Очищення…" : COPY[scope].label}
        </button>
      ))}
      {error ? <span className="text-xs text-rose-400">{error}</span> : null}
    </div>
  );
}
