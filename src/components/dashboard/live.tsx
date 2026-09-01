"use client";

import { useCallback, useEffect, useState } from "react";
import type { DashboardPayload } from "@/lib/dashboard/types";
import { fmtNum, fmtPct, fmtTime, fmtUsd, pnlClass } from "@/components/dashboard/format";
import { Card, Empty, Pill, Stat, Table } from "@/components/dashboard/ui";

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

export function useDashboard() {
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/dashboard", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = (await response.json()) as DashboardPayload;
      setData(json);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  return { data, error, loading, refresh, setData };
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
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
          hint={risk.killSwitchReason ?? "ENTER blocked when on"}
          tone={risk.killSwitch ? "bad" : "ok"}
        />
        <Stat
          label="Equity"
          value={fmtUsd(risk.equity)}
          hint={`peak ${fmtUsd(risk.peakEquity)}`}
        />
        <Stat
          label="Daily PnL"
          value={fmtUsd(risk.dailyPnl)}
          hint={`limit ${limits.maxDailyLossPct}%`}
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
        <Stat label="Ринки" value={`${data.markets.length}`} />
        <Stat label="Стратегії on" value={`${data.strategies.filter((s) => s.enabled).length}`} hint="seed = вимкнені" />
        <Stat label="Stale / breaker" value={`${risk.staleData ? "stale" : "fresh"} / ${risk.apiErrorBreaker ? "open" : "closed"}`} />
      </div>
    </div>
  );
}

export function PositionsPanel() {
  const { data, error, loading } = useDashboard();
  if (!data) return <Banner error={error} loading={loading} data={data} />;
  return (
    <Card title="Paper позиції (mark = bid/ask, не lastPrice)">
      <Table
        columns={[
          "Ринок",
          "Side",
          "Status",
          "Shares",
          "Avg",
          "Mark",
          "uPnL",
          "Realized",
          "lastPrice (істор.)",
        ]}
        empty="Немає позицій. Увімкніть стратегію і worker:paper — seed за замовчуванням idle."
        rows={data.positions.map((row) => [
          <span key="m">
            {row.marketTitle}
            <span className="mt-1 block text-xs text-zinc-500">{row.strategySlug ?? "—"}</span>
          </span>,
          row.side,
          <Pill key="s" tone={statusTone(row.status)}>{row.status}</Pill>,
          fmtNum(row.shares, 4),
          fmtNum(row.avgPrice, 4),
          row.mark === null ? "немає книги" : `${fmtNum(row.mark, 4)} (${row.markSource})`,
          <span key="u" className={pnlClass(row.unrealizedPnl)}>{fmtUsd(row.unrealizedPnl)}</span>,
          <span key="r" className={pnlClass(row.realizedPnl)}>{fmtUsd(row.realizedPnl)}</span>,
          fmtNum(row.lastPriceHistorical, 4),
        ])}
      />
    </Card>
  );
}

export function OrdersPanel() {
  const { data, error, loading } = useDashboard();
  if (!data) return <Banner error={error} loading={loading} data={data} />;
  return (
    <Card title="Ордери">
      <Table
        columns={["Час", "Ринок", "Side", "Status", "Notional", "Fill px", "Причина"]}
        empty="Ордерів ще немає."
        rows={data.orders.map((row) => [
          fmtTime(row.submittedAt),
          row.marketTitle,
          row.side,
          <Pill key="s" tone={statusTone(row.status)}>{row.status}</Pill>,
          fmtUsd(row.filledUsdtAmount ?? row.requestedAmount),
          fmtNum(row.averagePrice, 4),
          row.reason ?? "—",
        ])}
      />
    </Card>
  );
}

export function SignalsPanel() {
  const { data, error, loading } = useDashboard();
  if (!data) return <Banner error={error} loading={loading} data={data} />;
  return (
    <Card title="Сигнали">
      <Table
        columns={["Час", "Стратегія", "Ринок", "Dir", "Net edge", "Прийнято", "Причина"]}
        empty="Сигналів ще немає — стратегії в seed вимкнені."
        rows={data.signals.map((row) => [
          fmtTime(row.timestamp),
          row.strategySlug,
          row.marketTitle,
          row.direction,
          fmtNum(row.netEdge, 4),
          <Pill key="a" tone={row.accepted ? "ok" : "muted"}>{row.accepted ? "так" : "ні"}</Pill>,
          row.reason,
        ])}
      />
    </Card>
  );
}

export function MarketsPanel() {
  const { data, error, loading } = useDashboard();
  if (!data) return <Banner error={error} loading={loading} data={data} />;
  return (
    <Card title="Ринки · executable bid/ask, lastPrice лише як історія">
      <Table
        columns={["Ринок", "Symbol", "Bid", "Ask", "lastPrice (істор.)", "Chance", "Liq", "Книга"]}
        empty="Немає ринків. Запустіть worker:live / worker:rest."
        rows={data.markets.map((row) => [
          <span key="t">
            {row.title}
            <span className="mt-1 block text-xs text-zinc-500">{row.venueMarketId}</span>
          </span>,
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
  const { data, error, loading } = useDashboard();
  if (!data) return <Banner error={error} loading={loading} data={data} />;
  return (
    <Card title="Backtest runs">
      <Table
        columns={["Назва", "Стратегія", "Status", "Net PnL", "Max DD", "Trades", "WF"]}
        empty="Немає прогонів. npm run worker:backtest -- configs/backtest.momentum-lag.json"
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
    <Card title="Дослідницькі стратегії (увімкнення лише для paper worker)">
      <p className="mb-4 text-xs text-zinc-500">
        Live з цього екрана не вмикається. Paper worker ігнорує вимкнені стратегії.
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
          empty="Немає ingest:health:* у Redis — запустіть worker:live."
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
