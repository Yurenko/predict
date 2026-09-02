import type { ReactNode } from "react";

export function Card({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
      <h2 className="mb-4 text-sm font-medium text-zinc-300">{title}</h2>
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "ok" | "warn" | "bad" | "muted";
}) {
  const color =
    tone === "ok"
      ? "text-emerald-400"
      : tone === "warn"
        ? "text-amber-300"
        : tone === "bad"
          ? "text-rose-400"
          : "text-zinc-100";
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 px-3 py-3">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className={`mt-1 text-lg font-medium ${color}`}>{value}</p>
      {hint ? <p className="mt-1 text-xs text-zinc-500">{hint}</p> : null}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-zinc-500">{children}</p>;
}

export function Pill({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "ok" | "warn" | "bad" | "muted";
}) {
  const color =
    tone === "ok"
      ? "bg-emerald-950 text-emerald-300"
      : tone === "warn"
        ? "bg-amber-950 text-amber-300"
        : tone === "bad"
          ? "bg-rose-950 text-rose-300"
          : "bg-zinc-800 text-zinc-300";
  return (
    <span className={`inline-flex rounded-md px-2 py-0.5 text-xs ${color}`}>{children}</span>
  );
}

export function Table({
  columns,
  rows,
  empty,
  footer,
}: {
  columns: string[];
  rows: ReactNode[][];
  empty: string;
  footer?: ReactNode[];
}) {
  if (rows.length === 0) return <Empty>{empty}</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead>
          <tr className="border-b border-zinc-800 text-xs text-zinc-500">
            {columns.map((column) => (
              <th key={column} className="px-2 py-2 font-medium">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="border-b border-zinc-900/80">
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="px-2 py-2 align-top text-zinc-200">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {footer ? (
          <tfoot>
            <tr className="border-t border-zinc-700 text-zinc-100">
              {footer.map((cell, cellIndex) => (
                <td key={cellIndex} className="px-2 py-2 align-top font-medium">
                  {cell}
                </td>
              ))}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}
