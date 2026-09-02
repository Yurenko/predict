"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Огляд" },
  { href: "/record", label: "Запис" },
  { href: "/positions", label: "Позиції" },
  { href: "/orders", label: "Ордери" },
  { href: "/signals", label: "Сигнали" },
  { href: "/markets", label: "Ринки" },
  { href: "/backtests", label: "Бектести" },
  { href: "/strategies", label: "Стратегії" },
  { href: "/risk", label: "Ризик" },
  { href: "/observability", label: "Спостереження" },
] as const;

export function DashboardNav() {
  const pathname = usePathname();
  return (
    <header className="border-b border-zinc-800 bg-zinc-950/80 backdrop-blur">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-6 py-4">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <Link href="/" className="text-sm font-semibold tracking-tight text-zinc-100">
            bot-pol
          </Link>
          <p className="text-xs uppercase tracking-[0.2em] text-emerald-400">
            Phase 11 · Live (gated)
          </p>
        </div>
        <nav className="flex flex-wrap gap-1">
          {LINKS.map((link) => {
            const active =
              link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                className={
                  active
                    ? "rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-emerald-300"
                    : "rounded-lg px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
                }
              >
                {link.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
