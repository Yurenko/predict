"use client";

import { useCallback, useEffect, useState } from "react";
import type { DashboardPayload } from "@/lib/dashboard/types";
import { fmtAge, fmtNum, fmtPct, fmtRemaining, fmtTime, fmtUsd, pnlClass } from "@/components/dashboard/format";
import { paperSkipLabel } from "@/lib/paper/skip";
import { sumOpenUnrealized } from "@/lib/dashboard/equity";
import { applyHeldMarks } from "@/lib/dashboard/hold-mark";
import { ClearDataButtons } from "@/components/dashboard/clear";
import { Pager } from "@/components/dashboard/pager";
import { Card, Empty, Pill, Stat, Table } from "@/components/dashboard/ui";
import { ledgerPageCount } from "@/lib/dashboard/pages";

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
    return () => window.clearInterval(id);
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
  if (data.risk.killSwitch) {
    return {
      text: `Kill switch увімкнений (${data.risk.killSwitchReason ?? "ризик"}), але paper його ігнорує — нові входи йдуть. У книзі ${open} відкритих / ${closed} закритих. LIVE цей kill різав би ENTER.`,
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
      text: "Paper крутиться на віртуальному bankroll, але немає ринків, що закриваються протягом 24 год. Дивіться Запис (BTC/ETH/SOL) і перезапустіть Старт після зміни категорії.",
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
          label="Paper цикл"
          value={
            data.record.paper
              ? `${data.record.paper.filled} філів / ${data.record.paper.considered} ринків`
              : "ще не було"
          }
          hint={
            data.record.paper
              ? `${data.record.paper.enabled} стратегій · ${paperSkipLabel(data.record.paper.skip) ?? "ok"} · ${fmtAge(data.record.paper.at)}`
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
          hint="AWS IaC, live вимкнений"
          tone="ok"
        />
        <Stat
          label="Режим"
          value={data.tradingMode}
          hint={data.liveTradingEnabled ? "LIVE flags on" : "live вимкнений"}
          tone={data.liveTradingEnabled ? "bad" : "ok"}
        />
        <Stat
          label="Kill switch"
          value={risk.killSwitch ? "ON" : "off"}
          hint={
            risk.killSwitch
              ? `${risk.killSwitchReason ?? "armed"} · paper ігнорує, LIVE ріже ENTER`
              : "paper ігнорує kill / cooldown / slippage"
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
        <Stat label="Стратегії on" value={`${data.strategies.filter((s) => s.enabled).length}`} hint="потрібні для paper-сигналів; live звідси не вмикається" />
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
  if (kind === "signals") {
    if (noBook) {
      return "Немає сигналів, бо немає prediction книги. Коли з’являться ринки, сюди впадуть BUY/SELL.";
    }
    return "Немає рядка Signal: стратегії поки не дали BUY/SELL вхід. Гіпотетичні EXIT на вкладці Запис — це не ордер. Accepted = так після віртуального FILLED.";
  }
  if (kind === "orders") {
    if (noBook) {
      return "Немає paper-ордерів. Поки немає prediction книги — таблиця порожня. PlaceOrder на біржу не йде.";
    }
    return "Немає paper-ордерів: входу ще не було, або філ відхилено. PlaceOrder на біржу не йде.";
  }
  return "Немає paper-позицій. Вони з’являться після віртуального FILLED. Реальні гроші не списуються.";
}

export function PositionsPanel() {
  const [page, setPage] = useState(1);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);
  const { data, error, loading, refresh, setData } = useDashboard({ positionsPage: page });
  if (!data) return <Banner error={error} loading={loading} data={data} />;
  const realized = data.ledger.closedRealized;
  const openMark = sumOpenUnrealized(data.positions);
  const closedPage = data.ledger.pages.positions;

  async function closePosition(id: string) {
    if (!window.confirm("Закрити цю paper-позицію по поточній книзі (не чекати експірі)?")) return;
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
        setCloseError(
          json.error === "no_book"
            ? "Немає bid/ask, щоб закрити"
            : json.error === "not_open"
              ? "Вже закрита"
              : json.error ?? `HTTP ${response.status}`,
        );
        return;
      }
      setData(json);
    } catch (err) {
      setCloseError(String(err));
    } finally {
      setClosingId(null);
    }
  }
  return (
    <Card title="Paper позиції (mark = bid/ask)">
      <PaperBanner data={data} />
      <p className="mb-3 max-w-3xl text-xs leading-5 text-zinc-500">
        Статистика угоди: Avg = вхід, Mark = жива книга поки OPEN, Exit = ціна філу закриття
        (книга, кнопка Закрити, або settlement 0/1). uPnL лише для OPEN. Разом — усі закриті, не лише ця сторінка.
      </p>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <ClearDataButtons
          scopes={["paper"]}
          onDone={() => {
            setPage(1);
            void refresh();
          }}
        />
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
          row.side,
          <Pill key="s" tone={statusTone(row.status)}>{row.status}</Pill>,
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
          row.side,
          <Pill key="s" tone={statusTone(row.status)}>{row.status}</Pill>,
          fmtUsd(row.filledUsdtAmount ?? row.requestedAmount),
          fmtNum(row.averagePrice, 4),
          row.reason ?? "—",
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
          row.direction,
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
    <Card title="Ринки · закриття протягом 24 год · bid/ask executable">
      <PaperBanner data={data} />
      <Table
        columns={["Ринок", "До кінця", "Symbol", "Bid", "Ask", "lastPrice (істор.)", "Chance", "Liq", "Книга"]}
        empty="Немає ринків, що закриваються протягом 24 год. Після Старт сюди мають потрапити live-спорт і короткі Up/Down, не довгі FDV на кшталт $500M."
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

  async function setEntryMode(entryMode: "all" | "single") {
    const response = await fetch("/api/dashboard/strategies", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryMode }),
    });
    if (!response.ok) return;
    setData((await response.json()) as DashboardPayload);
  }

  const mode = data.paperEntryMode;
  return (
    <Card title="Дослідницькі стратегії (увімкнення лише для paper worker)">
      <p className="mb-4 text-xs text-zinc-500">
        Live з цього екрана не вмикається. Увімкнені стратегії торгують лише на віртуальному bankroll
        після Старт на Огляді. Реальні гроші не списуються.
      </p>
      <div className="mb-5 rounded-xl border border-zinc-800 px-3 py-3">
        <p className="mb-2 text-sm text-zinc-200">Вхід на одному контракті</p>
        <p className="mb-3 text-xs leading-5 text-zinc-500">
          «Одна стратегія» — перший сигнал займає книгу, інші не відкривають копію $50.
          «Усі стратегії» — кожна ввімкнена може увійти окремо на той самий ринок.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void setEntryMode("single")}
            className={
              mode === "single"
                ? "rounded-lg border border-emerald-800 bg-emerald-950 px-3 py-1.5 text-sm text-emerald-200"
                : "rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800"
            }
          >
            Одна стратегія
          </button>
          <button
            type="button"
            onClick={() => void setEntryMode("all")}
            className={
              mode === "all"
                ? "rounded-lg border border-emerald-800 bg-emerald-950 px-3 py-1.5 text-sm text-emerald-200"
                : "rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800"
            }
          >
            Усі стратегії
          </button>
        </div>
      </div>
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
          Arm kill switch зараз лише для LIVE. У PAPER записи kill / cooldown лишаються на екрані,
          але цикл paper все одно входить.
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
          <Stat label="Live flags" value={data.liveTradingEnabled ? "ON" : "off"} hint="тільки env, не з UI" />
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
