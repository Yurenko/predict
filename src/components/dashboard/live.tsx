"use client";

import { useCallback, useEffect, useState } from "react";
import type { DashboardPayload } from "@/lib/dashboard/types";
import { fmtAge, fmtNum, fmtPct, fmtRemaining, fmtTime, fmtUsd, pnlClass } from "@/components/dashboard/format";
import { PAPER_SKIP, paperSkipLabel } from "@/lib/paper/skip";
import { sumOpenUnrealized } from "@/lib/dashboard/equity";
import { applyHeldMarks } from "@/lib/dashboard/hold-mark";
import { ClearDataButtons } from "@/components/dashboard/clear";
import { Pager } from "@/components/dashboard/pager";
import { Card, Empty, Pill, Stat, Table } from "@/components/dashboard/ui";
import { EquityChart } from "@/components/dashboard/equity-chart";
import { ledgerPageCount } from "@/lib/dashboard/pages";
import { signalIntentLabel, orderIntentLabel, orderNotionalUsd } from "@/lib/live/intent-label";
import { DASHBOARD_RESET_EVENT } from "@/components/dashboard/clear";

function positionSideLabel(row: { side: string; outcomeName?: string | null }): string {
  const token = row.outcomeName?.trim();
  if (!token) return row.side;
  return `${row.side} ${token}`;
}

function statusTone(status: string): "ok" | "warn" | "bad" | "muted" {
  if (status === "FILLED" || status === "OPEN" || status === "ok") return "ok";
  if (status === "PARTIALLY_FILLED" || status === "PENDING" || status === "SUBMITTED") return "warn";
  if (
    status === "FAILED" ||
    status === "EXPIRED" ||
    status === "CANCELLED" ||
    status === "error"
  ) {
    return "bad";
  }
  return "muted";
}

export function useDashboard(pages?: {
  positionsPage?: number;
  ordersPage?: number;
  signalsPage?: number;
}) {
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const query = new URLSearchParams();
      if (pages?.positionsPage && pages.positionsPage > 1) {
        query.set("positionsPage", String(pages.positionsPage));
      }
      if (pages?.ordersPage && pages.ordersPage > 1) {
        query.set("ordersPage", String(pages.ordersPage));
      }
      if (pages?.signalsPage && pages.signalsPage > 1) {
        query.set("signalsPage", String(pages.signalsPage));
      }
      const suffix = query.toString();
      const response = await fetch(suffix ? `/api/dashboard?${suffix}` : "/api/dashboard", {
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = (await response.json()) as DashboardPayload;
      setData((prev) => applyHeldMarks(prev, json));
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [pages?.ordersPage, pages?.positionsPage, pages?.signalsPage]);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 5_000);
    const onReset = () => void refresh();
    window.addEventListener(DASHBOARD_RESET_EVENT, onReset);
    return () => {
      window.clearInterval(id);
      window.removeEventListener(DASHBOARD_RESET_EVENT, onReset);
    };
  }, [refresh]);

  return { data, error, loading, refresh, setData };
}

function markCell(row: { status: string; mark: number | null; markSource: string; markHeld?: boolean }): string {
  if (row.status !== "OPEN") return "—";
  if (row.mark === null) return "немає книги";
  const source = row.markHeld ? `${row.markSource} · last` : row.markSource;
  return `${fmtNum(row.mark, 4)} (${source})`;
}

function MarketCell({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string | null;
}) {
  return (
    <span>
      {title}
      {subtitle ? <span className="mt-1 block text-xs text-zinc-500">{subtitle}</span> : null}
    </span>
  );
}

function paperHint(data: DashboardPayload): { text: string; tone: "ok" | "warn" | "muted" } {
  const paper = data.record.paper;
  const enabled = data.strategies.filter((row) => row.enabled).length;
  const open = data.ledger.openPositions;
  const closed = data.ledger.closedPositions;
  const live = data.liveTradingEnabled;
  if (live) {
    if (data.risk.killSwitch) {
      return {
        text: `Kill switch ON (${data.risk.killSwitchReason ?? "ручний"}) — LIVE не відкриває нові позиції. EXIT дозволений. Зніми kill на сторінці Ризик, щоб знову входити.`,
        tone: "warn",
      };
    }
    if (!data.record.running) {
      return {
        text: "LIVE зупинено: стратегії не відкривають нові позиції. Кнопка Закрити все одно шле реальний SELL. Філи з Binance підтягуються в Позиції навіть після Стоп.",
        tone: "warn",
      };
    }
    if (paper && paper.filled > 0) {
      return {
        text: `LIVE: ${paper.filled} ордерів на ${paper.considered} ринках. Ордери з’являються одразу (SUBMITTED → FILLED), позиція оновлює shares/avg після філу з Binance.`,
        tone: "ok",
      };
    }
    if (paper) {
      const skip =
        paper.considered === 0 && open > 0
          ? PAPER_SKIP.waitingNextHorizon
          : paper.skip;
      return {
        text: `LIVE цикл: ${paper.filled} ордерів / ${paper.considered} ринків · ${paper.enabled} стратегій. ${paperSkipLabel(skip) ?? ""}`.trim(),
        tone: paper.considered === 0 ? "warn" : "muted",
      };
    }
    return {
      text: "LIVE після Старт. Увімкніть стратегії, якщо ще ні — інакше цикл idle.",
      tone: enabled === 0 ? "warn" : "muted",
    };
  }
  if (data.risk.killSwitch) {
    return {
      text: `Kill switch увімкнений (${data.risk.killSwitchReason ?? "ризик"}), але paper його ігнорує — нові входи йдуть. У книзі ${open} відкритих / ${closed} закритих.`,
      tone: "muted",
    };
  }
  if (paper && paper.filled > 0) {
    return {
      text: `Віртуальний рахунок: ${paper.filled} філів на ${paper.considered} ринках. Binance placeOrder не викликається.`,
      tone: "ok",
    };
  }
  if (paper && (open > 0 || closed > 0)) {
    return {
      text: `Paper працює без реальних грошей: у книзі ${open} відкритих / ${closed} закритих. Цикл зараз ${paper.filled} нових філів / ${paper.considered} ринків · ${paper.enabled} стратегій (0 нових ≠ порожня історія).`,
      tone: "ok",
    };
  }
  if (paper) {
    return {
      text: `Paper працює без реальних грошей: ${paper.filled} філів / ${paper.considered} ринків · ${paper.enabled} стратегій. ${paperSkipLabel(paper.skip) ?? ""}`.trim(),
      tone: paper.considered === 0 ? "warn" : "muted",
    };
  }
  if (enabled === 0) {
    return {
      text: "Увімкніть стратегії — paper крутить віртуальний bankroll, реальні гроші не списуються.",
      tone: "warn",
    };
  }
  if (data.markets.length === 0) {
    return {
      text: "Paper крутиться на віртуальному bankroll, але зараз немає BTC/ETH/BNB 5m або 15m Up/Down у вікні до експірі.",
      tone: "warn",
    };
  }
  return {
    text: "Paper на віртуальному bankroll. Сигнали й ордери з’являться, коли стратегія дасть BUY/SELL. PlaceOrder на біржу не йде.",
    tone: "muted",
  };
}

function PaperBanner({ data }: { data: DashboardPayload }) {
  const hint = paperHint(data);
  return (
    <p
      className={
        hint.tone === "ok"
          ? "mb-4 max-w-3xl text-sm leading-6 text-emerald-300"
          : hint.tone === "warn"
            ? "mb-4 max-w-3xl text-sm leading-6 text-amber-200"
            : "mb-4 max-w-3xl text-sm leading-6 text-zinc-400"
      }
    >
      {hint.text}
      {data.risk.killSwitch ? (
        <>
          {" "}
          <a href="/risk" className="text-zinc-300 underline underline-offset-2">
            Ризик
          </a>
        </>
      ) : null}
    </p>
  );
}

function Banner({ error, loading, data }: { error: string | null; loading: boolean; data: DashboardPayload | null }) {
  if (loading && !data) return <Empty>Завантаження…</Empty>;
  if (error && !data) return <Empty>Не вдалося прочитати dashboard: {error}</Empty>;
  if (data?.health.database === "error") {
    return (
      <Empty>
        PostgreSQL недоступна — таблиці порожні, поки не підніметься docker compose.
      </Empty>
    );
  }
  return null;
}

export function OverviewPanel() {
  const { data, error, loading } = useDashboard();
  if (!data) return <Banner error={error} loading={loading} data={data} />;
  const { risk, health, limits } = data;
  return (
    <div className="space-y-6">
      <Banner error={error} loading={loading} data={data} />
      <PaperBanner data={data} />
      <EquityChart
        curve={data.equityCurve}
        bankroll={data.limits.bankrollUsdt}
        mode={data.tradingMode}
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Запис"
          value={data.record.running ? "ON" : "off"}
          hint={
            data.record.lastSampleAt
              ? `тіки ${data.record.tickCount} · ${fmtAge(data.record.lastSampleAt)}`
              : data.record.collecting
                ? "потік є, запис off"
                : "натисніть Старт вище"
          }
          tone={data.record.running ? "ok" : "muted"}
        />
        <Stat
          label={data.liveTradingEnabled ? "Live цикл" : "Paper цикл"}
          value={
            data.record.paper
              ? `${data.record.paper.filled} ${data.liveTradingEnabled ? "ордерів" : "філів"} / ${data.record.paper.considered} ринків`
              : "ще не було"
          }
          hint={
            data.record.paper
              ? `${data.record.paper.enabled} стратегій · ${paperSkipLabel(data.record.paper.skip) ?? "ok"} · ${fmtAge(data.record.paper.at)}`
              : data.liveTradingEnabled
                ? "після Старт LIVE"
                : "після Старт або worker:paper"
          }
          tone={
            data.record.paper && data.record.paper.filled > 0
              ? "ok"
              : data.record.paper && data.record.paper.considered === 0
                ? "warn"
                : "muted"
          }
        />
        <Stat
          label="Рахунок"
          value={data.account.walletPreview ?? "не заданий"}
          hint={`${data.account.accountType} · bankroll ${fmtUsd(data.account.bankrollUsdt)}`}
          tone={data.account.hasWallet ? "ok" : "warn"}
        />
        <Stat
          label="Фаза"
          value={String(data.phase)}
          hint="AWS IaC, Docker live off; локально npm run dev:live"
          tone="ok"
        />
        <Stat
          label="Режим"
          value={data.tradingMode}
          hint={data.liveTradingEnabled ? "npm run dev:live" : "live вимкнений"}
          tone={data.liveTradingEnabled ? "bad" : "ok"}
        />
        <Stat
          label="Kill switch"
          value={risk.killSwitch ? "ON" : "off"}
          hint={
            risk.killSwitch
              ? `${risk.killSwitchReason ?? "armed"} · paper ігнорує; LIVE ріже ENTER лише якщо ON`
              : "вимкнений · LIVE ENTER не блокує"
          }
          tone={risk.killSwitch ? "warn" : "ok"}
        />
        <Stat
          label="Equity"
          value={fmtUsd(risk.mtmEquity)}
          hint={`закриті ${fmtUsd(risk.realizedEquity)} · відкриті ${fmtUsd(risk.unrealizedPnl)}${risk.openMissingMark ? ` · ${risk.openMissingMark} без книги` : ""}`}
          tone={risk.mtmEquity >= data.limits.bankrollUsdt ? "ok" : "warn"}
        />
        <Stat
          label="Daily PnL"
          value={fmtUsd(risk.dailyPnl)}
          hint={`лише закриті угоди · limit ${limits.maxDailyLossPct}%`}
          tone={risk.dailyPnl < 0 ? "bad" : "ok"}
        />
        <Stat label="Drawdown" value={fmtPct(risk.currentDrawdown)} hint={`max ${limits.maxDrawdownPct}%`} />
        <Stat
          label="Open"
          value={`${risk.openPositions}`}
          hint={fmtUsd(risk.openNotional)}
        />
        <Stat
          label="Database"
          value={health.database}
          tone={health.database === "ok" ? "ok" : "bad"}
        />
        <Stat
          label="Redis"
          value={health.redis}
          tone={health.redis === "ok" ? "ok" : "bad"}
        />
        <Stat
          label="Wallet / keys"
          value={data.hasWallet && data.hasPaperKeys ? "ready" : "missing"}
          hint={data.hasLiveKeys ? "live keys present (boolean only)" : "live keys missing"}
          tone={data.hasWallet && data.hasPaperKeys ? "ok" : "warn"}
        />
        <Stat label="Ринки" value={`${data.markets.length}`} hint={`закриття ≤ ${Math.round(limits.maxTimeToExpirySec / 3600)} год`} />
        <Stat label="Стратегії on" value={`${data.strategies.filter((s) => s.enabled).length}`} hint="після Старт на Огляді" />
        <Stat label="Stale / breaker" value={`${risk.staleData ? "stale" : "fresh"} / ${risk.apiErrorBreaker ? "open" : "closed"}`} />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {data.underlyings.map((row) => (
          <Stat
            key={row.symbol}
            label={row.symbol}
            value={fmtNum(row.price, 2)}
            hint={row.observedAt ? fmtAge(row.observedAt) : "немає underlying тіка"}
            tone={row.price ? "ok" : "muted"}
          />
        ))}
      </div>
      {data.collectors.length > 0 ? (
        <Card title="Що зараз відбувається">
          <Table
            columns={["Канал", "Останній", "Стан"]}
            empty="Немає collector heartbeats."
            rows={data.collectors.slice(0, 8).map((row) => [
              row.channel,
              fmtTime(row.lastAt),
              <Pill key={row.channel} tone={row.stale ? "bad" : "ok"}>
                {row.stale ? "тиша" : "дані йдуть"}
              </Pill>,
            ])}
          />
        </Card>
      ) : (
        <Empty>Після Старт тут з’являться канали WebSocket і ціни underlying.</Empty>
      )}
    </div>
  );
}

function paperTableEmpty(data: DashboardPayload, kind: "signals" | "orders" | "positions"): string {
  const skip = data.record.paper?.skip;
  const noBook =
    skip === "no_prediction_book" || skip === "no_near_expiry" || data.markets.length === 0;
  const live = data.liveTradingEnabled;
  if (kind === "signals") {
    if (noBook) {
      return "Немає сигналів, бо немає prediction книги. Коли з’являться ринки, сюди впадуть BUY/SELL.";
    }
    return "Немає рядка Signal: стратегії поки не дали BUY/SELL вхід. Гіпотетичні EXIT на вкладці Запис — це не ордер. Accepted = так після SUBMITTED, позиція — після філу з затримкою.";
  }
  if (kind === "orders") {
    if (live) {
      return "Немає LIVE-ордерів. Після Старт сюди падають placeOrder (SUBMITTED), потім FILLED з історії Binance.";
    }
    if (noBook) {
      return "Немає paper-ордерів. Поки немає prediction книги — таблиця порожня. PlaceOrder на біржу не йде.";
    }
    return "Немає paper-ордерів: входу ще не було, або філ відхилено. PlaceOrder на біржу не йде.";
  }
  if (live) {
    return "Немає LIVE-позицій. Вони з’являться після FILLED на біржі (не одразу з SUBMITTED).";
  }
  return "Немає paper-позицій. Ордер спочатку SUBMITTED, позиція з’явиться після філу (~5 с). Реальні гроші не списуються.";
}

function claimStatusLabel(status: string | null): string {
  if (!status) return "";
  const upper = status.toUpperCase();
  if (upper === "CONFIRMED" || upper === "CLAIMED" || upper === "REDEEMED" || upper === "SUCCESS" || upper === "DONE") {
    return "отримано";
  }
  if (upper === "PENDING" || upper === "SUBMITTED") return "claim…";
  if (upper === "FAILED") return "claim fail";
  return status;
}

function closeErrorText(code: string): string {
  switch (code) {
    case "no_book":
      return "Немає bid/ask, щоб закрити";
    case "not_open":
      return "Вже закрита";
    case "not_found":
      return "Позицію не знайдено";
    case "not_paper":
      return "Це LIVE-позиція — закриття йде через біржу. Оновіть сторінку і натисніть Закрити ще раз";
    case "not_live":
      return "Це не LIVE-позиція";
    case "quote_failed":
      return "getQuote не вдався — спробуйте ще раз";
    case "inflight":
      return "Вже є незавершений ордер по цьому ринку — зачекайте філ";
    case "below_market_min_amount":
      return "Сума менша за мінімум біржі";
    case "persist_failed":
      return "Ордер міг піти на біржу, але не записався локально";
    case "above_max_position":
      return "Сума ордера більша за ліміт позиції";
    case "place_failed":
      return "Binance не прийняв ордер";
    case "missing_wallet_id":
    case "live_adapter_unavailable":
    case "no_runtime":
      return "LIVE адаптер або wallet недоступний";
    default:
      return code;
  }
}

export function PositionsPanel() {
  const [page, setPage] = useState(1);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);
  const { data, error, loading, refresh, setData } = useDashboard({ positionsPage: page });
  if (!data) return <Banner error={error} loading={loading} data={data} />;
  const realized =
    data.ledger.closedRealized +
    data.positions
      .filter((row) => row.status === "OPEN")
      .reduce((sum, row) => sum + row.realizedPnl, 0);
  const openMark = sumOpenUnrealized(data.positions);
  const closedPage = data.ledger.pages.positions;
  const liveClose = data.liveTradingEnabled;

  async function claimAll() {
    if (!window.confirm("Надіслати claim (batchRedeem) на Binance для всіх PENDING_CLAIM? Авто-claim чекає 1 хв після експірі.")) {
      return;
    }
    setClaiming(true);
    setCloseError(null);
    try {
      const response = await fetch("/api/dashboard/positions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "claim" }),
      });
      const json = (await response.json()) as DashboardPayload & { error?: string; claimed?: number };
      if (!response.ok) {
        setCloseError(closeErrorText(json.error ?? `HTTP ${response.status}`));
        return;
      }
      setData(json);
      setCloseError(
        json.claimed && json.claimed > 0
          ? null
          : "Немає токенів у PENDING_CLAIM, або ще не минула 1 хв після експірі.",
      );
    } catch (err) {
      setCloseError(String(err));
    } finally {
      setClaiming(false);
      void refresh();
    }
  }

  async function closePosition(id: string) {
    if (
      !window.confirm(
        liveClose
          ? "Закрити цю LIVE-позицію реальним SELL на Binance? Стоп не блокує закриття."
          : "Закрити цю paper-позицію по поточній книзі (не чекати експірі)?",
      )
    ) {
      return;
    }
    setClosingId(id);
    setCloseError(null);
    try {
      const response = await fetch("/api/dashboard/positions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const json = (await response.json()) as DashboardPayload & { error?: string };
      if (!response.ok) {
        setCloseError(closeErrorText(json.error ?? `HTTP ${response.status}`));
        return;
      }
      setData(json);
      const stillOpen = json.positions.some((row) => row.id === id && row.status === "OPEN");
      if (liveClose && stillOpen) {
        setCloseError("Ордер на закриття відправлено. Позиція зникне з OPEN після філу Binance.");
      }
    } catch (err) {
      setCloseError(String(err));
    } finally {
      setClosingId(null);
    }
  }
  return (
    <Card title={data.liveTradingEnabled ? "LIVE позиції" : "Paper позиції (mark = bid/ask)"}>
      <PaperBanner data={data} />
      <p className="mb-3 max-w-3xl text-xs leading-5 text-zinc-500">
        Статистика угоди: Avg = вхід, Mark = жива книга поки OPEN, Exit = ціна філу закриття
        (книга, кнопка Закрити, або settlement 0/1). uPnL лише для OPEN. Разом realized — закриті + часткові
        виходи ще OPEN рядків.
        {data.liveTradingEnabled
          ? " У LIVE кнопка Закрити шле реальний SELL і працює після Стоп. Стоп лише зупиняє нові входи стратегій. Після експірі слот вже вільний: claim (batchRedeem, автоматом через 1 хв або «Отримати все») лише забирає виграш в USDT і не блокує ENTER, якщо на гаманці вже є квиток."
          : " Paper: після експірі позиція спочатку закривається без 0/1 (як Live чекає Binance), settlement з’являється з затримкою. Mark до закриття — остання книга, не миттєвий джекпот."}
      </p>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <ClearDataButtons
          scopes={["paper"]}
          onDone={() => {
            setPage(1);
            void refresh();
          }}
        />
        {data.liveTradingEnabled ? (
          <button
            type="button"
            disabled={claiming || closingId !== null}
            onClick={() => void claimAll()}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
          >
            {claiming ? "Отримую…" : "Отримати все"}
          </button>
        ) : null}
        {closeError ? <span className="text-xs text-rose-400">{closeError}</span> : null}
      </div>
      <Table
        columns={[
          "Ринок",
          "До кінця",
          "Side",
          "Status",
          "Shares",
          "Avg",
          "Mark",
          "Exit",
          "uPnL",
          "Realized",
          "",
        ]}
        empty={paperTableEmpty(data, "positions")}
        rows={data.positions.map((row) => [
          <MarketCell key="m" title={row.marketTitle} subtitle={row.strategySlug} />,
          <span key="e">
            {fmtTime(row.endDate)}
            <span className="mt-1 block text-xs text-zinc-500">{fmtRemaining(row.endDate)}</span>
          </span>,
          positionSideLabel(row),
          <span key="s">
            <Pill tone={statusTone(row.status)}>{row.status}</Pill>
            {row.claimStatus ? (
              <span className="mt-1 block text-xs text-zinc-500">{claimStatusLabel(row.claimStatus)}</span>
            ) : null}
          </span>,
          fmtNum(row.shares, 4),
          fmtNum(row.avgPrice, 4),
          markCell(row),
          row.status === "OPEN" ? "—" : fmtNum(row.exitPrice, 4),
          <span key="u" className={pnlClass(row.status === "OPEN" ? row.unrealizedPnl : null)}>{fmtUsd(row.status === "OPEN" ? row.unrealizedPnl : null)}</span>,
          <span key="r" className={pnlClass(row.realizedPnl)}>{fmtUsd(row.realizedPnl)}</span>,
          row.status === "OPEN" ? (
            <button
              key="c"
              type="button"
              disabled={closingId !== null}
              onClick={() => void closePosition(row.id)}
              className="rounded-lg border border-zinc-700 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
            >
              {closingId === row.id ? "Закриваю…" : "Закрити"}
            </button>
          ) : (
            ""
          ),
        ])}
        footer={
          data.ledger.openPositions + data.ledger.closedPositions === 0
            ? undefined
            : [
                "Разом",
                "",
                "",
                "",
                "",
                "",
                openMark.missingMark ? `${openMark.missingMark} без книги` : "",
                "",
                <span key="u" className={pnlClass(openMark.pnl)}>{fmtUsd(openMark.pnl)}</span>,
                <span key="r" className={pnlClass(realized)}>{fmtUsd(realized)}</span>,
                "",
              ]
        }
      />
      <Pager
        page={closedPage.page}
        pageCount={ledgerPageCount(closedPage.total, closedPage.pageSize)}
        total={closedPage.total}
        unit="закритих"
        onPage={setPage}
      />
    </Card>
  );
}

export function OrdersPanel() {
  const [page, setPage] = useState(1);
  const { data, error, loading, refresh } = useDashboard({ ordersPage: page });
  if (!data) return <Banner error={error} loading={loading} data={data} />;
  const ordersPage = data.ledger.pages.orders;
  return (
    <Card title="Ордери">
      <PaperBanner data={data} />
      <p className="mb-3 max-w-3xl text-xs leading-5 text-zinc-500">
        Side: BUY UP / BUY DOWN — відкриття; EXIT BUY / EXIT SELL — повний вихід з цього токена
        (один LIMIT GTC на весь стек, не дрібні MARKET SELL). Notional для SUBMITTED — сума, яку
        шлемо на біржу; після FILLED — фактичний fill.
      </p>
      <div className="mb-4">
        <ClearDataButtons
          scopes={["paper"]}
          onDone={() => {
            setPage(1);
            void refresh();
          }}
        />
      </div>
      <Table
        columns={["Час", "Ринок", "Side", "Status", "Notional", "Fill px", "Причина"]}
        empty={paperTableEmpty(data, "orders")}
        rows={data.orders.map((row) => [
          fmtTime(row.submittedAt),
          <MarketCell key="m" title={row.marketTitle} />,
          orderIntentLabel({
            side: row.side,
            outcomeName: row.outcomeName,
            intent: row.intent ?? row.reason,
            action: row.action,
          }),
          <Pill key="s" tone={statusTone(row.status)}>{row.status}</Pill>,
          fmtUsd(
            orderNotionalUsd({
              status: row.status,
              filledUsdtAmount: row.filledUsdtAmount,
              requestedAmount: row.requestedAmount,
            }),
          ),
          fmtNum(row.averagePrice, 4),
          row.reason && row.reason !== "submitted"
            ? row.reason
            : row.side === "SELL"
              ? orderIntentLabel({
                  side: row.side,
                  outcomeName: row.outcomeName,
                  intent: row.intent ?? row.reason,
                  action: row.action,
                })
              : "—",
        ])}
      />
      <Pager
        page={ordersPage.page}
        pageCount={ledgerPageCount(ordersPage.total, ordersPage.pageSize)}
        total={ordersPage.total}
        unit="ордерів"
        onPage={setPage}
      />
    </Card>
  );
}

export function SignalsPanel() {
  const [page, setPage] = useState(1);
  const { data, error, loading, refresh } = useDashboard({ signalsPage: page });
  if (!data) return <Banner error={error} loading={loading} data={data} />;
  const signalsPage = data.ledger.pages.signals;
  return (
    <Card title="Сигнали">
      <PaperBanner data={data} />
      <p className="mb-3 max-w-3xl text-xs leading-5 text-zinc-500">
        BUY UP — купівля токена Up. BUY DOWN — купівля токена Down (сигнал SELL). EXIT BUY / EXIT SELL —
        повний продаж того токена. Стратегія не чіпає чужі позиції. LIVE як Paper: протилежний сигнал
        спочатку закриває ногу, інша сторона — після CLOSED.
      </p>
      <div className="mb-4">
        <ClearDataButtons
          scopes={["paper"]}
          onDone={() => {
            setPage(1);
            void refresh();
          }}
        />
      </div>
      <Table
        columns={["Час", "Стратегія", "Ринок", "Dir", "Net edge", "Прийнято", "Причина"]}
        empty={paperTableEmpty(data, "signals")}
        rows={data.signals.map((row) => [
          fmtTime(row.timestamp),
          row.strategySlug,
          <MarketCell key="m" title={row.marketTitle} />,
          signalIntentLabel({ direction: row.direction, outcomeName: row.outcomeName }),
          fmtNum(row.netEdge, 4),
          <Pill key="a" tone={row.accepted ? "ok" : "muted"}>{row.accepted ? "так" : "ні"}</Pill>,
          row.reason,
        ])}
      />
      <Pager
        page={signalsPage.page}
        pageCount={ledgerPageCount(signalsPage.total, signalsPage.pageSize)}
        total={signalsPage.total}
        unit="сигналів"
        onPage={setPage}
      />
    </Card>
  );
}

export function MarketsPanel() {
  const { data, error, loading } = useDashboard();
  if (!data) return <Banner error={error} loading={loading} data={data} />;
  return (
    <Card title="Ринки · BTC/ETH/BNB 5m і 15m · bid/ask executable">
      <PaperBanner data={data} />
      <Table
        columns={["Ринок", "До кінця", "Symbol", "Bid", "Ask", "lastPrice (істор.)", "Chance", "Liq", "Книга"]}
        empty="Немає BTC/ETH/BNB 5m або 15m Up/Down у вікні до експірі. 1h/1d, SOL і спорт сюди не потрапляють."
        rows={data.markets.map((row) => [
          <span key="t">
            {row.title}
            <span className="mt-1 block text-xs text-zinc-500">
              {row.topicTitle && row.topicTitle !== row.title ? `${row.topicTitle} · ` : ""}
              {row.venueMarketId}
            </span>
          </span>,
          fmtRemaining(row.endDate),
          row.symbol ?? "—",
          fmtNum(row.bestBid, 4),
          fmtNum(row.bestAsk, 4),
          fmtNum(row.lastPriceHistorical, 4),
          fmtNum(row.chance, 4),
          fmtUsd(row.liquidity),
          <Pill key="b" tone={row.liveBook ? "ok" : "muted"}>{row.liveBook ? "live WS" : "snapshot"}</Pill>,
        ])}
      />
    </Card>
  );
}

export function BacktestsPanel() {
  const { data, error, loading, setData } = useDashboard();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<{
    presets: Array<{ id: string; label: string; strategy: string }>;
    snapshots: { count: number; from: string | null; to: string | null };
  } | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/dashboard/backtests", { cache: "no-store" });
        if (!response.ok) return;
        setCatalog((await response.json()) as NonNullable<typeof catalog>);
      } catch {
        // keep table even if catalog fails
      }
    })();
  }, []);

  async function run(id: string) {
    setBusy(id);
    setNotice(null);
    try {
      const response = await fetch("/api/dashboard/backtests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, useRecorded: true }),
      });
      const json = (await response.json()) as {
        error?: string;
        trades?: number;
        netPnl?: number;
        eventsHint?: string | null;
        dashboard?: DashboardPayload;
      };
      if (!response.ok) {
        setNotice(json.error ?? `HTTP ${response.status}`);
        return;
      }
      if (json.dashboard) setData(json.dashboard);
      setNotice(
        json.eventsHint ??
          `Готово: ${json.trades ?? 0} угод, PnL ${fmtUsd(json.netPnl ?? 0)}. Реальних грошей немає.`,
      );
    } catch (err) {
      setNotice(String(err));
    } finally {
      setBusy(null);
    }
  }

  if (!data) return <Banner error={error} loading={loading} data={data} />;
  return (
    <div className="space-y-6">
      <Card title="Прогін на записаній книзі">
        <p className="mb-4 max-w-3xl text-sm leading-6 text-zinc-400">
          Бектест читає вже збережені prediction-знімки (не live-спот). Після Старт на Огляді
          collector пише книгу сюди. Натисніть стратегію — окремий процес у терміналі не потрібен.
        </p>
        {catalog ? (
          <p className="mb-4 text-xs text-zinc-500">
            Знімків у базі: {catalog.snapshots.count}
            {catalog.snapshots.from
              ? ` · ${fmtTime(catalog.snapshots.from)} → ${fmtTime(catalog.snapshots.to)}`
              : " · книги ще немає, прогін поверне пояснення"}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {(catalog?.presets ?? [
            { id: "momentum-lag", label: "Underlying Momentum Lag", strategy: "underlying-momentum-lag" },
            { id: "mean-reversion", label: "Mean Reversion", strategy: "mean-reversion" },
            { id: "fair-value", label: "Fair Value", strategy: "fair-value" },
          ]).map((row) => (
            <button
              key={row.id}
              type="button"
              disabled={busy !== null}
              onClick={() => void run(row.id)}
              className="rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
            >
              {busy === row.id ? "Прогін…" : `Прогнати ${row.label}`}
            </button>
          ))}
        </div>
        {notice ? <p className="mt-4 text-sm text-amber-200">{notice}</p> : null}
      </Card>
      <Card title="Результати">
        <Table
          columns={["Назва", "Стратегія", "Status", "Net PnL", "Max DD", "Trades", "WF"]}
          empty="Немає прогонів. Натисніть Прогнати вище."
          rows={data.backtests.map((row) => [
            row.name,
            row.strategySlug,
            row.status,
            <span key="p" className={pnlClass(row.netPnl)}>{fmtUsd(row.netPnl)}</span>,
            fmtPct(row.maxDrawdown),
            `${row.tradeCount}`,
            row.walkForward ? "так" : "ні",
          ])}
        />
      </Card>
    </div>
  );
}

export function StrategiesPanel() {
  const { data, error, loading, setData } = useDashboard();
  if (!data) return <Banner error={error} loading={loading} data={data} />;

  async function toggle(slug: string, enabled: boolean) {
    const response = await fetch("/api/dashboard/strategies", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug, enabled }),
    });
    if (!response.ok) return;
    setData((await response.json()) as DashboardPayload);
  }

  return (
    <Card title="Дослідницькі стратегії">
      <p className="mb-4 text-xs text-zinc-500">
        Увімкнені стратегії торгують після Старт на Огляді: у paper — віртуальний bankroll, у LIVE —
        реальний placeOrder. Режим задає команда запуску (`npm run dev` або `npm run dev:live`), не
        цей екран. Underlying vs window start: свічка 5m/15m відносно свого open (startPrice). Нижче
        старту → Down, вище → Up. Якщо 1м уже розвернулась — йдемо за 1м, крім останніх 2 хв вікна
        (там свічка/settlement, 1м гніт ігноруємо). Не змішуємо старий 15м lookback у 5м контракт.
        На одному вікні — одна стратегія. Протилежний сигнал спочатку закриває ногу, інша сторона
        відкривається після CLOSED. Paper тепер як Live: ордер спочатку SUBMITTED, філ з затримкою;
        після експірі слот звільняється одразу, 0/1 приходить пізніше. Claim у Live не блокує нові
        входи.
      </p>
      <div className="space-y-3">
        {data.strategies.length === 0 ? (
          <Empty>Немає рядків Strategy — запустіть prisma db seed.</Empty>
        ) : (
          data.strategies.map((row) => (
            <div
              key={row.slug}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-800 px-3 py-3"
            >
              <div>
                <p className="text-sm text-zinc-100">{row.name}</p>
                <p className="text-xs text-zinc-500">{row.slug}</p>
                {row.description ? (
                  <p className="mt-1 max-w-xl text-xs text-zinc-500">{row.description}</p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => void toggle(row.slug, !row.enabled)}
                className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800"
              >
                {row.enabled ? "Вимкнути" : "Увімкнути"}
              </button>
            </div>
          ))
        )}
      </div>
    </Card>
  );
}

export function RiskPanel() {
  const { data, error, loading, setData } = useDashboard();
  if (!data) return <Banner error={error} loading={loading} data={data} />;

  async function setKill(killSwitch: boolean) {
    const response = await fetch("/api/dashboard/risk", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ killSwitch }),
    });
    if (!response.ok) return;
    setData((await response.json()) as DashboardPayload);
  }

  return (
    <div className="space-y-6">
      <Card title="Risk state">
        <p className="mb-4 max-w-3xl text-xs leading-5 text-zinc-500">
          Kill за замовчуванням вимкнений і не ріже позиції. Увімкни його тут, лише коли треба
          зупинити нові LIVE-входи (EXIT лишається). Paper kill ігнорує завжди. Старт LIVE скидає
          kill у off.
        </p>
        <div className="mb-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void setKill(true)}
            className="rounded-lg border border-rose-800 px-3 py-1.5 text-sm text-rose-300 hover:bg-rose-950"
          >
            Arm kill switch
          </button>
          <button
            type="button"
            onClick={() => void setKill(false)}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800"
          >
            Зняти kill
          </button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Stat label="Kill" value={data.risk.killSwitch ? "ON" : "off"} tone={data.risk.killSwitch ? "bad" : "ok"} />
          <Stat label="Cooldown" value={fmtTime(data.risk.cooldownUntil)} />
          <Stat label="Consecutive losses" value={`${data.risk.consecutiveLosses}`} />
          <Stat label="Stale" value={data.risk.staleData ? "yes" : "no"} />
          <Stat label="API breaker" value={data.risk.apiErrorBreaker ? "open" : "closed"} />
          <Stat label="Live flags" value={data.liveTradingEnabled ? "ON" : "off"} hint="npm run dev:live, не з UI" />
        </div>
      </Card>
      <Card title="Risk events">
        <Table
          columns={["Час", "Type", "Sev", "Повідомлення"]}
          empty="Подій ризику ще немає."
          rows={data.riskEvents.map((row) => [
            fmtTime(row.createdAt),
            row.type,
            row.severity,
            row.message,
          ])}
        />
      </Card>
    </div>
  );
}

interface HealthDto {
  ready: boolean;
  alive: boolean;
  database: string;
  redis: string;
  tradingMode: string;
  liveTradingEnabled: boolean;
  hasWallet: boolean;
  hasPaperKeys: boolean;
  hasLiveKeys?: boolean;
  collectors: Array<{
    channel: string;
    lastAt: string | null;
    ageMs: number | null;
    stale: boolean;
  }>;
  alerts: Array<{ severity: string; code: string; message: string }>;
  metrics: { counters: Record<string, number>; gauges: Record<string, number> };
}

export function ObservabilityPanel() {
  const [data, setData] = useState<HealthDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch("/api/health", { cache: "no-store" });
        const json = (await response.json()) as HealthDto;
        if (!cancelled) {
          setData(json);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(String(err));
      }
    }
    void load();
    const id = window.setInterval(() => void load(), 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  if (!data && error) return <Empty>Не вдалося прочитати /api/health: {error}</Empty>;
  if (!data) return <Empty>Завантаження…</Empty>;

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Alive" value="yes" tone="ok" />
        <Stat label="Ready" value={data.ready ? "yes" : "no"} tone={data.ready ? "ok" : "bad"} />
        <Stat label="Database" value={data.database} tone={data.database === "ok" ? "ok" : "bad"} />
        <Stat label="Redis" value={data.redis} tone={data.redis === "ok" ? "ok" : "bad"} />
      </div>
      <Card title="Алерти">
        <Table
          columns={["Sev", "Code", "Повідомлення"]}
          empty="Немає алертів."
          rows={data.alerts.map((row) => [
            <Pill
              key={row.code}
              tone={row.severity === "error" ? "bad" : row.severity === "warn" ? "warn" : "muted"}
            >
              {row.severity}
            </Pill>,
            row.code,
            row.message,
          ])}
        />
      </Card>
      <Card title="Collector heartbeats">
        <Table
          columns={["Channel", "Останній", "Age ms", "Stale"]}
          empty="Немає live-каналів (spot ticker / prediction orderbook). Натисніть Старт на Огляді."
          rows={data.collectors.map((row) => [
            row.channel,
            fmtTime(row.lastAt),
            row.ageMs === null ? "—" : `${row.ageMs}`,
            <Pill key="s" tone={row.stale ? "bad" : "ok"}>{row.stale ? "stale" : "fresh"}</Pill>,
          ])}
        />
      </Card>
      <Card title="Counters (цей процес Next.js)">
        <Table
          columns={["Metric", "Value"]}
          empty="Лічильники цього процесу порожні. Workers мають власний / окремий memory space — див. worker observe."
          rows={Object.entries(data.metrics.counters).map(([key, value]) => [key, `${value}`])}
        />
        <p className="mt-3 text-xs text-zinc-500">
          JSON: /api/metrics · Prometheus: /api/metrics?format=prom · Ready: /api/ready
        </p>
      </Card>
    </div>
  );
}
