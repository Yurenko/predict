"use client";

import { fmtTime, fmtUsd } from "@/components/dashboard/format";
import { Card, Empty } from "@/components/dashboard/ui";
import type { DashboardEquityPoint } from "@/lib/dashboard/types";

function pathFrom(points: Array<{ x: number; y: number }>): string {
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(" ");
}

export function EquityChart(options: {
  curve: DashboardEquityPoint[];
  bankroll: number;
  mode: "PAPER" | "LIVE";
}) {
  const curve = options.curve;
  if (curve.length === 0) {
    return (
      <Card title="Рахунок">
        <Empty>Немає точок equity — після перших закритих угод тут з’явиться крива.</Empty>
      </Card>
    );
  }

  const last = curve[curve.length - 1]?.equity ?? options.bankroll;
  const delta = last - options.bankroll;
  const growing = delta >= 0;
  const width = 640;
  const height = 220;
  const pad = { left: 52, right: 16, top: 16, bottom: 32 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const equities = curve.map((point) => point.equity);
  const min = Math.min(options.bankroll, ...equities);
  const max = Math.max(options.bankroll, ...equities);
  const span = max - min || Math.max(1, Math.abs(options.bankroll) * 0.05);
  const yMin = min - span * 0.08;
  const yMax = max + span * 0.08;
  const t0 = Date.parse(curve[0]?.t ?? "");
  const t1 = Date.parse(curve[curve.length - 1]?.t ?? "");
  const tSpan = Math.max(1, t1 - t0);

  const xy = curve.map((point) => {
    const t = Date.parse(point.t);
    const x = pad.left + ((t - t0) / tSpan) * innerW;
    const y = pad.top + ((yMax - point.equity) / (yMax - yMin)) * innerH;
    return { x, y };
  });
  const bankrollY = pad.top + ((yMax - options.bankroll) / (yMax - yMin)) * innerH;
  const line = pathFrom(xy);
  const area = `${line} L${xy[xy.length - 1]?.x.toFixed(1)} ${(pad.top + innerH).toFixed(1)} L${xy[0]?.x.toFixed(1)} ${(pad.top + innerH).toFixed(1)} Z`;
  const stroke = growing ? "#34d399" : "#fb7185";
  const fill = growing ? "rgba(52, 211, 153, 0.14)" : "rgba(251, 113, 133, 0.14)";

  return (
    <Card title="Рахунок">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className={`text-2xl font-medium ${growing ? "text-emerald-400" : "text-rose-400"}`}>
            {fmtUsd(last)}
          </p>
          <p className="text-xs text-zinc-500">
            {growing ? "росте" : "спадає"} {delta >= 0 ? "+" : "−"}
            {fmtUsd(Math.abs(delta))} від bankroll {fmtUsd(options.bankroll)} · {options.mode}
          </p>
        </div>
        <p className="text-xs text-zinc-500">
          Закриті угоди + mark відкритих. Останнє оновлення {fmtTime(curve[curve.length - 1]?.t)}.
        </p>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-56 w-full" role="img" aria-label="Графік рахунку">
        <line
          x1={pad.left}
          x2={width - pad.right}
          y1={bankrollY}
          y2={bankrollY}
          stroke="#3f3f46"
          strokeDasharray="4 4"
        />
        <path d={area} fill={fill} />
        <path d={line} fill="none" stroke={stroke} strokeWidth="2" />
        {xy.length > 0 ? (
          <circle cx={xy[xy.length - 1]?.x} cy={xy[xy.length - 1]?.y} r="3.5" fill={stroke} />
        ) : null}
        <text x={4} y={pad.top + 4} fill="#a1a1aa" fontSize="11">
          {fmtUsd(yMax)}
        </text>
        <text x={4} y={pad.top + innerH} fill="#a1a1aa" fontSize="11">
          {fmtUsd(yMin)}
        </text>
        <text x={pad.left} y={height - 8} fill="#71717a" fontSize="11">
          {fmtTime(curve[0]?.t)}
        </text>
        <text x={width - pad.right} y={height - 8} fill="#71717a" fontSize="11" textAnchor="end">
          {fmtTime(curve[curve.length - 1]?.t)}
        </text>
      </svg>
    </Card>
  );
}
