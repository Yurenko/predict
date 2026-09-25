"use client";

import { useCallback, useEffect, useState } from "react";
import type { RecordPayload, RecordTickView } from "@/lib/record/types";
import { paperSkipLabel } from "@/lib/paper/skip";
import { fmtAge, fmtDuration, fmtNum, fmtPct, fmtRemaining, fmtTime, fmtUsd, pnlClass } from "@/components/dashboard/format";
import { Card, Empty, Pill, Stat, Table } from "@/components/dashboard/ui";
import { ClearDataButtons, DASHBOARD_RESET_EVENT } from "@/components/dashboard/clear";
import { Pager } from "@/components/dashboard/pager";
import { LEDGER_PAGE_SIZE, ledgerPageCount, slicePage } from "@/lib/dashboard/pages";

function statusLabel(data: RecordPayload): { text: string; tone: "ok" | "warn" | "bad" | "muted"; hint: string } {
  const live = data.liveTradingEnabled;
  if (data.running && !data.workerAlive) {
    return {
      text: "Воркер зупинився",
      tone: "bad",
      hint: data.lastError ?? "натисніть Стоп, потім Старт ще раз",
    };
  }
  if (data.running && data.lastSampleAt) {
    return {
      text: live ? "LIVE торгівля" : "Записує",
      tone: live ? "bad" : "ok",
      hint: `останній тік ${fmtAge(data.lastSampleAt)}`,
    };
  }
  if (data.running && data.workerAlive) {
    return { text: "Запуск…", tone: "warn", hint: "піднімає WebSocket у цьому процесі, без окремого вікна" };
  }
  if (data.collecting) {
    return { text: "Підключено", tone: "ok", hint: "потік є, запис зупинено" };
  }
  return {
    text: "Не записує",
    tone: "muted",
    hint: live
      ? "натисніть Старт — реальні placeOrder на біржу"
      : "натисніть Старт — paper на віртуальному bankroll, без Binance placeOrder",
  };
}

export function useRecordFeed() {
  const [data, setData] = useState<RecordPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/dashboard/record", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setData((await response.json()) as RecordPayload);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 2_000);
    const onReset = () => void refresh();
    window.addEventListener(DASHBOARD_RESET_EVENT, onReset);
    return () => {
      window.clearInterval(id);
      window.removeEventListener(DASHBOARD_RESET_EVENT, onReset);
    };
  }, [refresh]);

  const control = useCallback(async (action: "start" | "stop") => {
    setBusy(true);
    try {
      const response = await fetch("/api/dashboard/record", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setData((await response.json()) as RecordPayload);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  return { data, error, busy, refresh, control };
}

export function RecordControls() {
  const { data, error, busy, control, refresh } = useRecordFeed();
  if (!data) {
    return (
      <Card title="Запис">
        <Empty>{error ? `Не вдалося прочитати запис: ${error}` : "Завантаження…"}</Empty>
      </Card>
    );
  }
  const status = statusLabel(data);
  const live = data.liveTradingEnabled;
  const keysReady = live ? data.account.hasLiveKeys : data.account.hasPaperKeys;
  return (
      <Card title={live ? "LIVE торгівля (реальні гроші)" : "Paper запис (віртуальні гроші)"}>
      <div className="mb-4 max-w-2xl space-y-2 text-sm leading-6 text-zinc-300">
        {live ? (
          <p>
            Той самий Старт/Стоп, що в paper. Після Старт цикл: стратегія → сигнал → офіційний
            placeOrder на bankroll {fmtUsd(data.account.bankrollUsdt)}.{" "}
            <span className="text-rose-300">Реальні гроші списуються з гаманця Binance.</span> Стоп
            зупиняє нові входи стратегій; кнопка Закрити на Позиціях працює далі.
          </p>
        ) : (
          <p>
            Старт пише live-дані і крутить paper-цикл: стратегія → сигнал → віртуальний ордер на
            bankroll {fmtUsd(data.account.bankrollUsdt)}.{" "}
            <span className="text-zinc-100">Binance placeOrder не викликається, реальні гроші не списуються.</span>
          </p>
        )}
        <p className="text-xs leading-5 text-zinc-500">
          Ринок: BTC/ETH/BNB Up/Down 5m, 15m, 1h і 1d. Вхід лише коли сигнал, свічка і LLM
          збігаються, ask ≤ 0.55 і edge від 8%. Вихід: тейк (mark ≥ 0.45 і +0.20), стоп (mark ≤ entry−0.15
          або нижче 0.25) або свічка проти позиції — без очікування LLM.
        </p>
        <p className="text-xs leading-5 text-zinc-500">
          Дивіться вкладки Сигнали, Ордери і Позиції. FAILED з причиною missing_quote / no_executable_book
          — це теж «як працює»: спроба була, філ без офіційного getQuote не симулюємо.
        </p>
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy || (data.running && data.workerAlive)}
          onClick={() => void control("start")}
          className={
            live
              ? "rounded-lg border border-rose-800 bg-rose-950 px-4 py-2 text-sm text-rose-200 hover:bg-rose-900 disabled:opacity-40"
              : "rounded-lg border border-emerald-800 bg-emerald-950 px-4 py-2 text-sm text-emerald-200 hover:bg-emerald-900 disabled:opacity-40"
          }
        >
          {busy && !(data.running && data.workerAlive)
            ? "Запуск…"
            : data.running && !data.workerAlive
              ? "Перезапустити"
              : live
                ? "Старт LIVE"
                : "Старт"}
        </button>
        <button
          type="button"
          disabled={busy || !data.running}
          onClick={() => void control("stop")}
          className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
        >
          Стоп
        </button>
        <Pill tone={status.tone}>{status.text}</Pill>
        <span className="text-xs text-zinc-500">{status.hint}</span>
        <ClearDataButtons scopes={["paper", "record"]} onDone={() => void refresh()} />
      </div>
      {error ? <p className="mb-3 text-xs text-rose-400">{error}</p> : null}
      {data.lastError ? <p className="mb-3 text-xs text-amber-300">{data.lastError}</p> : null}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Рахунок"
          value={data.account.walletPreview ?? "не заданий"}
          hint={`${data.account.accountType} · ${live ? "live" : "paper"} bankroll ${fmtUsd(data.account.bankrollUsdt)}`}
          tone={data.account.hasWallet ? "ok" : "warn"}
        />
        <Stat
          label={live ? "Ключі live" : "Ключі paper"}
          value={keysReady ? "є" : "немає"}
          hint={live ? "BINANCE_LIVE_* для placeOrder" : "paper getQuote для філу; placeOrder ніколи"}
          tone={keysReady ? "ok" : "warn"}
        />
        <Stat
          label="Воркер"
          value={data.workerAlive ? "живий" : "вимкнений"}
          hint={data.collecting ? "книга live WS" : "чекає на WebSocket"}
          tone={data.workerAlive || data.collecting ? "ok" : "muted"}
        />
        <Stat
          label="Сесія"
          value={data.session ? `${data.session.tickCount} тіків` : "немає"}
          hint={
            data.session
              ? `${data.session.signalCount} гіпотетичних сигналів (не ордери) · ${fmtDuration(data.session.startedAt, data.session.stoppedAt)}`
              : "Старт відкриє нову сесію"
          }
        />
        <Stat
          label={live ? "Live цикл" : "Paper цикл"}
          value={
            data.paper
              ? `${data.paper.filled} ${live ? "ордерів" : "філів"} / ${data.paper.considered} ринків`
              : "ще не було"
          }
          hint={
            data.paper
              ? `${data.paper.enabled} стратегій on · ${paperSkipLabel(data.paper.skip) ?? "ok"} · ${fmtAge(data.paper.at)}`
              : "після Старт з’явиться цикл"
          }
          tone={data.paper && data.paper.filled > 0 ? "ok" : data.paper && data.paper.considered === 0 ? "warn" : "muted"}
        />
      </div>
    </Card>
  );
}

function Sparkline({
  points,
  color,
}: {
  points: Array<number | null>;
  color: string;
}) {
  const values = points.filter((value): value is number => value !== null && Number.isFinite(value));
  if (values.length < 2) {
    return <p className="text-xs text-zinc-600">мало точок</p>;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  let cursor = 0;
  const d = points
    .map((value, index) => {
      if (value === null || !Number.isFinite(value)) return null;
      const x = (index / Math.max(1, points.length - 1)) * 160;
      const y = 40 - ((value - min) / span) * 36;
      const cmd = cursor === 0 ? "M" : "L";
      cursor += 1;
      return `${cmd}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .filter(Boolean)
    .join(" ");
  return (
    <svg viewBox="0 0 160 40" className="h-10 w-full" role="img" aria-label="sparkline">
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}

export function RecordTapePanel() {
  const { data, error } = useRecordFeed();
  const [tickPage, setTickPage] = useState(1);
  const [signalPage, setSignalPage] = useState(1);
  if (!data) return <Empty>{error ? error : "Завантаження…"}</Empty>;

  const chronological = [...data.ticks].reverse();
  const byMarket = (() => {
    const map = new Map<string, RecordTickView[]>();
    for (const tick of chronological) {
      const list = map.get(tick.marketId) ?? [];
      list.push(tick);
      map.set(tick.marketId, list);
    }
    return [...map.entries()].slice(0, 6);
  })();

  const hypothetical = data.ticks.flatMap((tick) =>
    tick.signals.map((signal) => ({
      at: tick.observedAt,
      market: tick.marketTitle,
      ...signal,
    })),
  );

  return (
    <div className="space-y-6">
      <RecordControls />
      <div className="grid gap-3 sm:grid-cols-3">
        {data.underlyings.map((row) => (
          <Stat
            key={row.symbol}
            label={row.symbol}
            value={fmtNum(row.price, 2)}
            hint={row.observedAt ? fmtAge(row.observedAt) : "немає тіка"}
            tone={row.price ? "ok" : "muted"}
          />
        ))}
      </div>
      <Card title="Collector heartbeats">
        <Table
          columns={["Канал", "Останній", "Вік", "Стан"]}
          empty="Немає heartbeats — натисніть Старт, щоб підняти WebSocket."
          rows={data.collectors.map((row) => [
            row.channel,
            fmtTime(row.lastAt),
            row.ageMs === null ? "—" : `${row.ageMs} мс`,
            <Pill key={row.channel} tone={row.stale ? "bad" : "ok"}>
              {row.stale ? "stale" : "live"}
            </Pill>,
          ])}
        />
      </Card>
      <Card title="Стрічка як у бектесті · фічі стратегії">
        {byMarket.length === 0 ? (
          <Empty>
            Поки немає тіків. Після Старт з’являться bid/ask, underlying returns і гіпотетичні сигнали.
          </Empty>
        ) : (
          <div className="mb-6 grid gap-4 lg:grid-cols-2">
            {byMarket.map(([id, ticks]) => {
              const last = ticks[ticks.length - 1];
              return (
                <div key={id} className="rounded-xl border border-zinc-800 px-3 py-3">
                  <p className="text-sm text-zinc-200">{last?.marketTitle}</p>
                  <p className="mb-2 text-xs text-zinc-500">
                    {last?.symbol ?? "—"} · chance {fmtNum(last?.chance, 4)} · und {fmtNum(last?.underlyingPrice, 2)}
                  </p>
                  <Sparkline points={ticks.map((tick) => tick.chance)} color="#34d399" />
                  <p className="mt-1 text-[10px] uppercase tracking-wide text-zinc-600">chance</p>
                  <Sparkline points={ticks.map((tick) => tick.underlyingPrice)} color="#60a5fa" />
                  <p className="mt-1 text-[10px] uppercase tracking-wide text-zinc-600">underlying</p>
                </div>
              );
            })}
          </div>
        )}
        <Table
          columns={[
            "Час",
            "Ринок",
            "Bid",
            "Ask",
            "Chance",
            "Und",
            "r1m",
            "r5m",
            "r15m",
            "z",
            "Сигнал",
          ]}
          empty="Немає записаних тіків."
          rows={slicePage(data.ticks, tickPage, LEDGER_PAGE_SIZE).map((row) => [
            fmtTime(row.observedAt),
            <span key={row.id}>
              {row.marketTitle}
              <span className="mt-1 block text-xs text-zinc-500">
                {row.symbol ?? "—"} · {row.liveBook ? "live WS" : "snapshot"}
                {row.timeToExpirySec != null
                  ? ` · ${fmtRemaining(new Date(Date.parse(row.observedAt) + row.timeToExpirySec * 1000).toISOString(), Date.parse(row.observedAt))}`
                  : ""}
              </span>
            </span>,
            fmtNum(row.bestBid, 4),
            fmtNum(row.bestAsk, 4),
            fmtNum(row.chance, 4),
            fmtNum(row.underlyingPrice, 2),
            fmtPct(row.underlyingReturn1m),
            fmtPct(row.underlyingReturn5m),
            fmtPct(row.underlyingReturn15m),
            fmtNum(row.probabilityZ, 2),
            row.signals[0] ? (
              <span key="s">
                <Pill tone={row.signals[0].direction === "EXIT" ? "warn" : "ok"}>
                  {row.signals[0].direction}
                </Pill>
                <span className={`mt-1 block text-xs ${pnlClass(row.signals[0].netEdge)}`}>
                  {row.signals[0].strategySlug} · edge {fmtNum(row.signals[0].netEdge, 4)}
                </span>
              </span>
            ) : (
              "—"
            ),
          ])}
        />
        <Pager
          page={Math.min(tickPage, ledgerPageCount(data.ticks.length, LEDGER_PAGE_SIZE))}
          pageCount={ledgerPageCount(data.ticks.length, LEDGER_PAGE_SIZE)}
          total={data.ticks.length}
          unit="тіків"
          onPage={setTickPage}
        />
      </Card>
      <Card title="Гіпотетичні сигнали (не ордери)">
        <Table
          columns={["Час", "Стратегія", "Ринок", "Dir", "Fair", "Net edge", "Причина"]}
          empty="Сигналу немає, бо немає prediction книги (bid/ask/chance). Зараз пишеться лише spot BTC/ETH/BNB. Колонка Сигнал у стрічці лишається «—» — це не збій."
          rows={slicePage(hypothetical, signalPage, LEDGER_PAGE_SIZE).map((row, index) => [
            fmtTime(row.at),
            row.strategySlug,
            row.market,
            <Pill key={index} tone="ok">
              {row.direction}
            </Pill>,
            fmtNum(row.fairProbability, 4),
            <span key="e" className={pnlClass(row.netEdge)}>
              {fmtNum(row.netEdge, 4)}
            </span>,
            row.reason,
          ])}
        />
        <Pager
          page={Math.min(signalPage, ledgerPageCount(hypothetical.length, LEDGER_PAGE_SIZE))}
          pageCount={ledgerPageCount(hypothetical.length, LEDGER_PAGE_SIZE)}
          total={hypothetical.length}
          unit="сигналів"
          onPage={setSignalPage}
        />
      </Card>
      <Card title="Сесії запису">
        <Table
          columns={["Початок", "Статус", "Тіки", "Сигнали", "Тривалість"]}
          empty="Сесій ще немає."
          rows={data.sessions.map((row) => [
            fmtTime(row.startedAt),
            row.status,
            `${row.tickCount}`,
            `${row.signalCount}`,
            fmtDuration(row.startedAt, row.stoppedAt),
          ])}
        />
      </Card>
    </div>
  );
}
