import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CURRENT_PHASE } from "@/lib/types/domain";
import { emptyDashboard } from "@/lib/dashboard/load";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

describe("phase 10 live-off AWS guards", () => {
  it("reports phase 10 on the empty dashboard payload", () => {
    expect(CURRENT_PHASE).toBe(11);
    expect(emptyDashboard().phase).toBe(11);
    expect(emptyDashboard().liveTradingEnabled).toBe(false);
  });

  it.each([
    "Dockerfile",
    "Dockerfile.worker",
    "docker-compose.app.yml",
    "infra/aws/ecs.tf",
  ])("%s pins LIVE_TRADING_ENABLED=false and never true", (file) => {
    const text = read(file);
    expect(text).toMatch(/LIVE_TRADING_ENABLED[\s\S]{0,120}?false/i);
    expect(text).not.toMatch(/LIVE_TRADING_ENABLED[\s\S]{0,120}?true/i);
  });

  it("does not bake Binance secrets into images or terraform", () => {
    const files = [
      "Dockerfile",
      "Dockerfile.worker",
      "docker-compose.app.yml",
      ...readdirSync(join(repoRoot, "infra/aws"))
        .filter((name) => name.endsWith(".tf") || name.endsWith(".example"))
        .map((name) => `infra/aws/${name}`),
    ];
    for (const file of files) {
      const text = read(file);
      expect(text, file).not.toMatch(/BINANCE_(PAPER|LIVE)_API_(KEY|SECRET)\s*=\s*"[^"]+"/);
      expect(text, file).not.toMatch(/ENV BINANCE_/);
    }
  });

  it("keeps live credentials out of Secrets Manager JSON", () => {
    const secrets = read("infra/aws/data.tf");
    expect(secrets).toContain("BINANCE_PAPER_API_KEY");
    expect(secrets).not.toMatch(/BINANCE_LIVE_API_/);
  });
});
