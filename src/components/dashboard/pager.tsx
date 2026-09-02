"use client";

export function Pager({
  page,
  pageCount,
  total,
  unit = "рядків",
  onPage,
}: {
  page: number;
  pageCount: number;
  total: number;
  unit?: string;
  onPage: (page: number) => void;
}) {
  if (total <= 0) return null;
  return (
    <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-zinc-500">
      <span>
        {total} {unit} · сторінка {page} з {pageCount}
      </span>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
        >
          Назад
        </button>
        <button
          type="button"
          disabled={page >= pageCount}
          onClick={() => onPage(page + 1)}
          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
        >
          Далі
        </button>
      </div>
    </div>
  );
}
