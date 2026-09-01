import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/config/env";
import { childLogger } from "@/lib/logger";
import { DataSource } from "@prisma/client";
import { insertNormalizedOrderbook, insertNormalizedUnderlying, upsertNormalizedTopic } from "@/lib/normalize/store";
import type { MarketDetailInput } from "@/lib/normalize/markets";
import { parseOrderbookPayload } from "@/lib/binance/sapi-wss";
import type { UnderlyingTicker } from "@/lib/binance/market-data-adapter";

const log = childLogger({ component: "normalize-replay" });

interface JsonlRow {
  channel?: string;
  observedAt?: string;
  payload?: unknown;
}

async function walkJsonl(dir: string): Promise<string[]> {
  const files: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkJsonl(full)));
    } else if (entry.name.endsWith(".jsonl")) {
      files.push(full);
    }
  }
  return files;
}

function asTicker(payload: unknown, observedAt: Date): UnderlyingTicker | null {
  if (!payload || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  const symbol = typeof row.s === "string" ? row.s : typeof row.symbol === "string" ? row.symbol : null;
  const price = Number(row.c ?? row.lastPrice ?? row.price);
  if (!symbol || !Number.isFinite(price)) return null;
  return {
    symbol,
    price,
    bid: Number.isFinite(Number(row.b ?? row.bidPrice)) ? Number(row.b ?? row.bidPrice) : undefined,
    ask: Number.isFinite(Number(row.a ?? row.askPrice)) ? Number(row.a ?? row.askPrice) : undefined,
    volume: Number.isFinite(Number(row.v ?? row.volume)) ? Number(row.v ?? row.volume) : undefined,
    eventTime: typeof row.E === "number" ? new Date(row.E) : observedAt,
    executable: false,
    raw: payload,
  };
}

export async function replayRawDirectory(root = env.RAW_DATA_DIR): Promise<{
  topics: number;
  books: number;
  underlyings: number;
  files: number;
}> {
  const files = await walkJsonl(root);
  const stats = { topics: 0, books: 0, underlyings: 0, files: files.length };

  for (const file of files) {
    const text = await readFile(file, "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let row: JsonlRow;
      try {
        row = JSON.parse(line) as JsonlRow;
      } catch {
        continue;
      }
      const channel = row.channel ?? "";
      const observedAt = row.observedAt ? new Date(row.observedAt) : new Date();

      if (channel.startsWith("prediction.market.detail.")) {
        const ok = await upsertNormalizedTopic(row.payload as MarketDetailInput);
        if (ok) stats.topics += 1;
      } else if (channel.startsWith("prediction.ws.orderbook.")) {
        const book = parseOrderbookPayload(row.payload);
        if (book && (await insertNormalizedOrderbook(book))) stats.books += 1;
      } else if (channel.startsWith("spot.")) {
        const ticker = asTicker(row.payload, observedAt);
        const source = channel.startsWith("spot.ws.") ? DataSource.WEBSOCKET : DataSource.REST;
        if (ticker && (await insertNormalizedUnderlying(ticker, source))) stats.underlyings += 1;
      }
    }
  }

  log.info(stats, "raw replay finished");
  return stats;
}
