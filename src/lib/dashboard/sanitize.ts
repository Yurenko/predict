export const SECRET_KEY_FRAGMENTS = [
  "BINANCE_PAPER_API_KEY",
  "BINANCE_PAPER_API_SECRET",
  "BINANCE_LIVE_API_KEY",
  "BINANCE_LIVE_API_SECRET",
  "apiSecret",
  "apiKey",
] as const;

const SECRET_VALUE_RE = /(api[_-]?secret|api[_-]?key|secretKey)/i;

export function redactCredentialMentions(text: string): string {
  return text
    .replace(/BINANCE_[A-Z0-9_]+/g, "BINANCE_*")
    .replace(/api[_-]?secrets?/gi, "credential")
    .replace(/api[_-]?keys?/gi, "credential");
}

export function containsSecrets(value: unknown): boolean {
  const text = JSON.stringify(value);
  if (!text) return false;
  if (SECRET_KEY_FRAGMENTS.some((fragment) => text.includes(fragment))) return true;
  return SECRET_VALUE_RE.test(text);
}

export function assertNoSecrets(payload: unknown): void {
  if (containsSecrets(payload)) {
    throw new Error("dashboard payload must not include API credentials");
  }
}
