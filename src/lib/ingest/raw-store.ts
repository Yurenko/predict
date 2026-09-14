import { appendFile, mkdir, writeFile, readFile, statfs, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { DataSource, type Prisma } from "@prisma/client";
import { env } from "@/lib/config/env";
import { prisma } from "@/lib/db/prisma";
import { redis } from "@/lib/db/redis";
import { payloadHash, toJsonSafe } from "@/lib/binance/payload";
import { childLogger } from "@/lib/logger";
import { inc } from "@/lib/observability/metrics";
import { keepLastExecutablePrices } from "@/lib/ingest/orderbook-merge";

const log = childLogger({ component: "raw-ingest" });
let rawMaintenanceAt = 0;
let rawMaintenancePromise: Promise<void> | null = null;

export interface IngestRecord {
  source: DataSource;
  channel: string;
  observedAt: Date;
  payload: unknown;
}

export async function ingestRaw(record: IngestRecord): Promise<"stored" | "duplicate" | "file-only"> {
  const payload = toJsonSafe(record.payload);
  const hash = payloadHash(payload);
  const redisKey = `ingest:last-hash:${record.channel}`;

  try {
    const previous = await redis.get(redisKey);
    if (previous === hash) {
      inc("ingest.result", { outcome: "duplicate" });
      return "duplicate";
    }
  } catch {
    // Redis is optional for collection.
  }

  const row = {
    source: record.source,
    channel: record.channel,
    observedAt: record.observedAt,
    payloadHash: hash,
    payload: payload as Prisma.InputJsonValue,
  };

  let storedInDb = false;
  try {
    const created = await prisma.rawIngestEvent.createMany({
      data: [row],
      skipDuplicates: true,
    });
    if (created.count === 0) {
      inc("ingest.result", { outcome: "duplicate" });
      return "duplicate";
    }
    storedInDb = true;
  } catch (error) {
    log.warn({ channel: record.channel, err: String(error) }, "postgres ingest failed, writing file");
  }

  const fileRow = {
    ...row,
    observedAt: record.observedAt.toISOString(),
  };

  if (env.RAW_FILE_PERSIST_MODE === "always" || (env.RAW_FILE_PERSIST_MODE === "fallback" && !storedInDb)) {
    try {
      await writeJsonl(record.channel, fileRow);
    } catch (error) {
      // Raw files are a safety fallback only; a filesystem problem must never
      // take down the collector/trading loop.
      log.error({ channel: record.channel, err: String(error) }, "raw file fallback write failed");
    }
  }

  try {
    await redis.set(redisKey, hash);
    await redis.set(
      `ingest:health:${record.channel}`,
      JSON.stringify({ at: record.observedAt.toISOString(), hash }),
    );
  } catch {
    // ignore
  }

  const outcome = storedInDb ? "stored" : "file-only";
  inc("ingest.result", { outcome });
  return outcome;
}

async function writeJsonl(channel: string, row: unknown): Promise<void> {
  if (env.RAW_FILE_PERSIST_MODE === "off") return;

  await maintainRawData();

  try {
    const freeBytes = await availableBytes(env.RAW_DATA_DIR);
    if (freeBytes < env.RAW_FILE_MIN_FREE_BYTES) {
      log.warn(
        { freeBytes, minFreeBytes: env.RAW_FILE_MIN_FREE_BYTES },
        "raw file fallback skipped because disk free space is low",
      );
      return;
    }
  } catch (error) {
    log.warn({ err: String(error) }, "raw file disk-space check failed; skipping fallback write");
    return;
  }

  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(env.RAW_DATA_DIR, channel.replaceAll(":", "_"));
  await mkdir(dir, { recursive: true });
  await appendFile(path.join(dir, `${day}.jsonl`), `${JSON.stringify(row)}\n`, "utf8");
}

/**
 * Raw JSONL is a bounded fallback/replay cache. PostgreSQL is the primary ingest store.
 * This maintenance pass removes expired files and then oldest files until the configured
 * byte budget is respected. It intentionally never touches `state/topics.json`.
 */
export async function maintainRawData(force = false): Promise<void> {
  if (env.RAW_FILE_PERSIST_MODE === "off") return;
  const now = Date.now();
  if (!force && now - rawMaintenanceAt < env.RAW_FILE_CLEANUP_INTERVAL_MS) return;
  if (rawMaintenancePromise) return rawMaintenancePromise;

  rawMaintenancePromise = (async () => {
    try {
      await mkdir(env.RAW_DATA_DIR, { recursive: true });
      const files = await collectRawFiles(env.RAW_DATA_DIR);
      const cutoff = now - env.RAW_FILE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

      for (const file of files) {
        if (file.mtimeMs < cutoff) {
          await unlinkSafe(file.path);
        }
      }

      const remaining = (await collectRawFiles(env.RAW_DATA_DIR)).sort(
        (a, b) => a.mtimeMs - b.mtimeMs,
      );
      let total = remaining.reduce((sum, file) => sum + file.size, 0);
      for (const file of remaining) {
        if (total <= env.RAW_FILE_MAX_TOTAL_BYTES) break;
        await unlinkSafe(file.path);
        total -= file.size;
      }

      rawMaintenanceAt = Date.now();
      if (files.length > 0) {
        log.info(
          {
            filesBefore: files.length,
            filesAfter: (await collectRawFiles(env.RAW_DATA_DIR)).length,
            totalBytes: total,
            maxBytes: env.RAW_FILE_MAX_TOTAL_BYTES,
          },
          "raw file maintenance complete",
        );
      }
    } catch (error) {
      rawMaintenanceAt = Date.now();
      log.warn({ err: String(error) }, "raw file maintenance failed");
    } finally {
      rawMaintenancePromise = null;
    }
  })();

  return rawMaintenancePromise;
}

async function availableBytes(root: string): Promise<number> {
  await mkdir(root, { recursive: true });
  const stats = await statfs(root);
  return Number(stats.bavail) * Number(stats.bsize);
}

async function collectRawFiles(root: string): Promise<Array<{ path: string; size: number; mtimeMs: number }>> {
  const result: Array<{ path: string; size: number; mtimeMs: number }> = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const stats = await stat(fullPath);
      result.push({ path: fullPath, size: stats.size, mtimeMs: stats.mtimeMs });
    }
  }

  await walk(root);
  return result;
}

async function unlinkSafe(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error: unknown) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code !== "ENOENT") throw error;
  }
}

export async function cacheLiveOrderbook(marketId: number, snapshot: unknown): Promise<void> {
  try {
    const key = `live:prediction:orderbook:${marketId}`;
    let previous: Record<string, unknown> | null = null;
    try {
      const raw = await redis.get(key);
      if (raw) previous = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      previous = null;
    }
    const incoming =
      snapshot && typeof snapshot === "object" ? (snapshot as Record<string, unknown>) : {};
    const merged = keepLastExecutablePrices(previous, incoming);
    await redis.set(key, JSON.stringify(toJsonSafe(merged)));
    await redis.set(
      "ingest:health:prediction.ws.orderbook",
      JSON.stringify({ at: new Date().toISOString(), marketId }),
    );
  } catch {
    // Redis is optional.
  }
}

export async function readLiveOrderbook(marketId: number | string): Promise<{
  marketId: number;
  updateTimestampMs: number;
  bestBid: string | number | null;
  bestAsk: string | number | null;
  bids?: Array<[string, string]>;
  asks?: Array<[string, string]>;
} | null> {
  try {
    const raw = await redis.get(`live:prediction:orderbook:${marketId}`);
    if (!raw) return null;
    return JSON.parse(raw) as {
      marketId: number;
      updateTimestampMs: number;
      bestBid: string | number | null;
      bestAsk: string | number | null;
      bids?: Array<[string, string]>;
      asks?: Array<[string, string]>;
    };
  } catch {
    return null;
  }
}

export async function rememberTopicIndex(index: unknown): Promise<void> {
  const serialized = JSON.stringify(toJsonSafe(index));
  const dir = path.join(env.RAW_DATA_DIR, "state");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "topics.json"), serialized, "utf8");
  try {
    await redis.set("ingest:prediction:topics", serialized);
  } catch {
    // ignore
  }
}

export async function readTopicIndex(): Promise<TopicIndex | null> {
  try {
    const cached = await redis.get("ingest:prediction:topics");
    if (cached) return JSON.parse(cached) as TopicIndex;
  } catch {
    // ignore
  }

  try {
    const file = await readFile(path.join(env.RAW_DATA_DIR, "state", "topics.json"), "utf8");
    return JSON.parse(file) as TopicIndex;
  } catch {
    return null;
  }
}

export interface TopicIndexOutcome {
  tokenId: string;
  name?: string;
}

export interface TopicIndexMarket {
  marketId: string;
  vendor?: string;
  outcomes: TopicIndexOutcome[];
}

export interface TopicIndexTopic {
  marketTopicId: string;
  vendor?: string;
  symbol?: string;
  markets: TopicIndexMarket[];
}

export interface TopicIndex {
  updatedAt: string;
  topics: TopicIndexTopic[];
}
