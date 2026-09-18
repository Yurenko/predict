"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { fmtTime, fmtUsd } from "@/components/dashboard/format";
import { Card, Empty } from "@/components/dashboard/ui";
import type { DashboardEquityPoint } from "@/lib/dashboard/types";
import {
  EQUITY_RANGE_PRESETS,
  clampEquityWindow,
  equityCurveExtent,
  equityWindowForRange,
  equityYDomain,
  sliceEquityCurve,
  zoomEquityWindow,
  type EquityRangeId,
} from "@/lib/dashboard/equity-curve";

function pathFrom(points: Array<{ x: number; y: number }>): string {
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(" ");
}

function fmtAxisTime(iso: string, spanMs: number): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  if (spanMs <= 48 * 60 * 60_000) {
    return date.toLocaleString("uk-UA", { hour12: false, hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleString("uk-UA", {
    hour12: false,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function svgCoords(event: { currentTarget: SVGSVGElement; clientX: number; clientY: number }) {
  const svg = event.currentTarget;
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const pt = svg.createSVGPoint();
  pt.x = event.clientX;
  pt.y = event.clientY;
  const mapped = pt.matrixTransform(ctm.inverse());
  return { x: mapped.x, y: mapped.y };
}

const WIDTH = 640;
const HEIGHT = 220;
const PAD = { left: 52, right: 16, top: 16, bottom: 32 };

export function EquityChart(options: {
  curve: DashboardEquityPoint[];
  bankroll: number;
  mode: "PAPER" | "LIVE";
}) {
  const curve = options.curve;
  const [range, setRange] = useState<EquityRangeId>("24h");
  const [custom, setCustom] = useState<{ fromMs: number; toMs: number } | null>(null);
  const [brush, setBrush] = useState<{ x0: number; x1: number } | null>(null);
  const [hover, setHover] = useState<{
    x: number;
    y: number;
    t: string;
    equity: number;
  } | null>(null);
  const dragRef = useRef<{ x0: number; pointerId: number } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const viewRef = useRef({
    window: null as { fromMs: number; toMs: number } | null,
    extent: null as { minMs: number; maxMs: number } | null,
    t0: 0,
    tSpan: 1,
    innerW: WIDTH - PAD.left - PAD.right,
  });

  const extent = useMemo(() => equityCurveExtent(curve), [curve]);
  const window = useMemo(
    () =>
      equityWindowForRange({
        curve,
        range,
        customFromMs: custom?.fromMs,
        customToMs: custom?.toMs,
      }),
    [curve, range, custom],
  );
  const visible = useMemo(() => {
    if (!window) return curve;
    return sliceEquityCurve(curve, window.fromMs, window.toMs);
  }, [curve, window]);

  const innerW = WIDTH - PAD.left - PAD.right;
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const t0 = window?.fromMs ?? (Date.parse(visible[0]?.t ?? "") || 0);
  const t1 = window?.toMs ?? (Date.parse(visible[visible.length - 1]?.t ?? "") || 0);
  const tSpan = Math.max(1, t1 - t0);
  viewRef.current = { window, extent, t0, tSpan, innerW };

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const view = viewRef.current;
      if (!view.extent || !view.window) return;
      const { x } = svgCoords({ currentTarget: svg, clientX: event.clientX, clientY: event.clientY });
      const clamped = Math.max(PAD.left, Math.min(WIDTH - PAD.right, x));
      const anchorMs = view.t0 + ((clamped - PAD.left) / view.innerW) * view.tSpan;
      const next = zoomEquityWindow({
        fromMs: view.window.fromMs,
        toMs: view.window.toMs,
        factor: event.deltaY > 0 ? 1.18 : 0.82,
        anchorMs,
        minMs: view.extent.minMs,
        maxMs: view.extent.maxMs,
      });
      setCustom(next);
      setRange("custom");
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [curve.length]);

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
  const { yMin, yMax } = equityYDomain(visible.map((point) => point.equity));
  const ySpan = yMax - yMin || 1;

  const xy = visible.map((point) => {
    const t = Date.parse(point.t);
    const x = PAD.left + ((t - t0) / tSpan) * innerW;
    const y = PAD.top + ((yMax - point.equity) / ySpan) * innerH;
    return { x, y, t: point.t, equity: point.equity };
  });
  const bankrollY = PAD.top + ((yMax - options.bankroll) / ySpan) * innerH;
  const bankrollVisible = bankrollY >= PAD.top && bankrollY <= PAD.top + innerH;
  const line = pathFrom(xy);
  const area =
    xy.length > 0
      ? `${line} L${xy[xy.length - 1]?.x.toFixed(1)} ${(PAD.top + innerH).toFixed(1)} L${xy[0]?.x.toFixed(1)} ${(PAD.top + innerH).toFixed(1)} Z`
      : "";
  const stroke = growing ? "#34d399" : "#fb7185";
  const fill = growing ? "rgba(52, 211, 153, 0.14)" : "rgba(251, 113, 133, 0.14)";

  function xToTime(x: number): number {
    const clamped = Math.max(PAD.left, Math.min(WIDTH - PAD.right, x));
    return t0 + ((clamped - PAD.left) / innerW) * tSpan;
  }

  function applyCustom(fromMs: number, toMs: number) {
    if (!extent) return;
    const next = clampEquityWindow({
      fromMs,
      toMs,
      minMs: extent.minMs,
      maxMs: extent.maxMs,
    });
    setCustom(next);
    setRange("custom");
  }

  function onPointerDown(event: PointerEvent<SVGSVGElement>) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const { x } = svgCoords(event);
    dragRef.current = { x0: x, pointerId: event.pointerId };
    setBrush({ x0: x, x1: x });
    setHover(null);
  }

  function onPointerMove(event: PointerEvent<SVGSVGElement>) {
    const { x, y } = svgCoords(event);
    if (dragRef.current) {
      setBrush({ x0: dragRef.current.x0, x1: x });
      return;
    }
    if (xy.length === 0 || y < PAD.top || y > PAD.top + innerH) {
      setHover(null);
      return;
    }
    let nearest = xy[0];
    let best = Number.POSITIVE_INFINITY;
    for (const point of xy) {
      const dist = Math.abs(point.x - x);
      if (dist < best) {
        best = dist;
        nearest = point;
      }
    }
    if (nearest) setHover(nearest);
  }

  function onPointerUp(event: PointerEvent<SVGSVGElement>) {
    const drag = dragRef.current;
    dragRef.current = null;
    setBrush(null);
    if (!drag) return;
    try {
      event.currentTarget.releasePointerCapture(drag.pointerId);
    } catch {
      // capture may already be released
    }
    const { x } = svgCoords(event);
    if (Math.abs(x - drag.x0) < 8) return;
    applyCustom(xToTime(drag.x0), xToTime(x));
  }

  function onDoubleClick() {
    setCustom(null);
    setRange("24h");
  }

  const brushLeft = brush ? Math.min(brush.x0, brush.x1) : 0;
  const brushWidth = brush ? Math.abs(brush.x1 - brush.x0) : 0;

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
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {EQUITY_RANGE_PRESETS.map((preset) => {
          const active = range === preset.id;
          return (
            <button
              key={preset.id}
              type="button"
              onClick={() => {
                setCustom(null);
                setRange(preset.id);
              }}
              className={`rounded-md px-2 py-1 text-xs ${
                active
                  ? "bg-zinc-100 text-zinc-900"
                  : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
              }`}
            >
              {preset.label}
            </button>
          );
        })}
        {range === "custom" ? (
          <button
            type="button"
            onClick={() => {
              setCustom(null);
              setRange("24h");
            }}
            className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          >
            скинути
          </button>
        ) : null}
        <span className="ml-auto text-[11px] text-zinc-500">
          Прокрутка — зум, протягнути — період
        </span>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-56 w-full cursor-crosshair touch-none"
        role="img"
        aria-label="Графік рахунку"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          if (!dragRef.current) setHover(null);
        }}
        onDoubleClick={onDoubleClick}
      >
        {bankrollVisible ? (
          <line
            x1={PAD.left}
            x2={WIDTH - PAD.right}
            y1={bankrollY}
            y2={bankrollY}
            stroke="#3f3f46"
            strokeDasharray="4 4"
          />
        ) : null}
        {area ? <path d={area} fill={fill} /> : null}
        {line ? <path d={line} fill="none" stroke={stroke} strokeWidth="2" /> : null}
        {xy.length > 0 ? (
          <circle cx={xy[xy.length - 1]?.x} cy={xy[xy.length - 1]?.y} r="3.5" fill={stroke} />
        ) : null}
        {brushWidth > 2 ? (
          <rect
            x={brushLeft}
            y={PAD.top}
            width={brushWidth}
            height={innerH}
            fill="rgba(244, 244, 245, 0.12)"
            stroke="#a1a1aa"
            strokeDasharray="3 3"
          />
        ) : null}
        {hover ? (
          <>
            <line
              x1={hover.x}
              x2={hover.x}
              y1={PAD.top}
              y2={PAD.top + innerH}
              stroke="#52525b"
              strokeDasharray="3 3"
            />
            <circle cx={hover.x} cy={hover.y} r="4" fill={stroke} />
          </>
        ) : null}
        <text x={4} y={PAD.top + 4} fill="#a1a1aa" fontSize="11">
          {fmtUsd(yMax)}
        </text>
        <text x={4} y={PAD.top + innerH} fill="#a1a1aa" fontSize="11">
          {fmtUsd(yMin)}
        </text>
        <text x={PAD.left} y={HEIGHT - 8} fill="#71717a" fontSize="11">
          {fmtAxisTime(new Date(t0).toISOString(), tSpan)}
        </text>
        <text x={WIDTH - PAD.right} y={HEIGHT - 8} fill="#71717a" fontSize="11" textAnchor="end">
          {fmtAxisTime(new Date(t1).toISOString(), tSpan)}
        </text>
      </svg>
      {hover ? (
        <p className="mt-2 text-xs text-zinc-400">
          {fmtTime(hover.t)} · {fmtUsd(hover.equity)}
        </p>
      ) : (
        <p className="mt-2 text-xs text-zinc-600">Наведіть на криву, щоб побачити точку.</p>
      )}
    </Card>
  );
}
