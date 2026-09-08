import { binanceCredentials, env } from "@/lib/config/env";
import { buildSapiSignedQuery } from "@/lib/binance/sapi-wss";
import { asNumber } from "@/lib/normalize/numbers";
import { childLogger } from "@/lib/logger";

const log = childLogger({ component: "live-wallet-usdt" });

function freeUsdtFromBalances(rows: unknown): number | null {
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    const asset = typeof item.asset === "string" ? item.asset.toUpperCase() : "";
    if (asset !== "USDT") continue;
    const free = asNumber(item.free);
    if (free != null && Number.isFinite(free)) return Math.max(0, free);
  }
  return null;
}

export function usdtFreeFromSpotAccount(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const balances = (body as { balances?: unknown }).balances;
  return freeUsdtFromBalances(balances);
}

export function usdtFreeFromFundingAsset(body: unknown): number | null {
  if (Array.isArray(body)) return freeUsdtFromBalances(body);
  if (body && typeof body === "object") {
    const rows = (body as { data?: unknown }).data;
    if (Array.isArray(rows)) return freeUsdtFromBalances(rows);
  }
  return freeUsdtFromBalances(body);
}

async function signedGetJson(url: string): Promise<unknown> {
  const { apiKey, apiSecret } = binanceCredentials();
  if (!apiKey || !apiSecret) return null;
  const { query } = buildSapiSignedQuery({ apiSecret, pairs: [] });
  const response = await fetch(`${url}?${query}`, {
    method: "GET",
    headers: { "X-MBX-APIKEY": apiKey },
  });
  const body = (await response.json()) as { code?: number; msg?: string };
  if (!response.ok || (body.code != null && body.code !== 0 && body.code !== 200)) {
    throw new Error(`wallet usdt ${response.status}: ${body.msg ?? body.code ?? "failed"}`);
  }
  return body;
}

async function signedPostJson(url: string): Promise<unknown> {
  const { apiKey, apiSecret } = binanceCredentials();
  if (!apiKey || !apiSecret) return null;
  const { query } = buildSapiSignedQuery({
    apiSecret,
    pairs: [["asset", "USDT"]],
  });
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "X-MBX-APIKEY": apiKey,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: query,
  });
  const body = (await response.json()) as { code?: number; msg?: string };
  if (!response.ok || (body.code != null && body.code !== 0 && body.code !== 200)) {
    throw new Error(`wallet usdt ${response.status}: ${body.msg ?? body.code ?? "failed"}`);
  }
  return body;
}

/** One snapshot per live cycle. null = unknown (skip ENTER). */
export async function fetchLiveUsdtAvailable(
  accountType: "SPOT" | "FUNDING" = env.BINANCE_PREDICTION_ACCOUNT_TYPE,
): Promise<number | null> {
  try {
    if (accountType === "FUNDING") {
      const url = `${env.BINANCE_PREDICTION_REST_BASE_URL.replace(/\/$/, "")}/sapi/v1/asset/get-funding-asset`;
      return usdtFreeFromFundingAsset(await signedPostJson(url));
    }
    const url = `${env.BINANCE_SPOT_REST_BASE_URL.replace(/\/$/, "")}/api/v3/account`;
    return usdtFreeFromSpotAccount(await signedGetJson(url));
  } catch (error) {
    log.warn({ err: String(error), accountType }, "live USDT balance unavailable");
    return null;
  }
}
