import { appendFile, mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { DataSource, type Prisma } from "@prisma/client";
import { env } from "@/lib/config/env";
import { prisma } from "@/lib/db/prisma";
import { redis } from "@/lib/db/redis";
import { payloadHash, toJsonSafe } from "@/lib/binance/payload";
import { childLogger } from "@/lib/logger";
import { inc } from "@/lib/observability/metrics";

const log = childLogger({ component: "raw-ingest" });

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
    await prisma.rawIngestEvent.create({ data: row });
    storedInDb = true;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "P2002") {
      inc("ingest.result", { outcome: "duplicate" });
      return "duplicate";
    }
    log.warn({ channel: record.channel, err: String(error) }, "postgres ingest failed, writing file");
  }

  await writeJsonl(record.channel, {
    ...row,
    observedAt: record.observedAt.toISOString(),
  });

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
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(env.RAW_DATA_DIR, channel.replaceAll(":", "_"));
  await mkdir(dir, { recursive: true });
  await appendFile(path.join(dir, `${day}.jsonl`), `${JSON.stringify(row)}\n`, "utf8");
}

export async function cacheLiveOrderbook(marketId: number, snapshot: unknown): Promise<void> {
  try {
    await redis.set(
      `live:prediction:orderbook:${marketId}`,
      JSON.stringify(toJsonSafe(snapshot)),
    );
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
