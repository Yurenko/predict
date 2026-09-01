export type MetricLabels = Record<string, string>;

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 64);
}

export function seriesKey(name: string, labels?: MetricLabels): string {
  if (!labels || Object.keys(labels).length === 0) return name;
  const inner = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${sanitize(key)}="${sanitize(value)}"`)
    .join(",");
  return `${name}{${inner}}`;
}

const counters = new Map<string, number>();
const gauges = new Map<string, number>();

export function resetMetrics(): void {
  counters.clear();
  gauges.clear();
}

export function inc(name: string, labels?: MetricLabels, by = 1): void {
  const key = seriesKey(name, labels);
  counters.set(key, (counters.get(key) ?? 0) + by);
}

export function setGauge(name: string, value: number, labels?: MetricLabels): void {
  gauges.set(seriesKey(name, labels), value);
}

export interface MetricsSnapshot {
  at: string;
  counters: Record<string, number>;
  gauges: Record<string, number>;
}

export function snapshotMetrics(): MetricsSnapshot {
  return {
    at: new Date().toISOString(),
    counters: Object.fromEntries(counters),
    gauges: Object.fromEntries(gauges),
  };
}

export function prometheusText(snapshot: MetricsSnapshot = snapshotMetrics()): string {
  const lines = ["# TYPE botpol_process_up gauge", "botpol_process_up 1"];
  for (const [key, value] of Object.entries(snapshot.counters)) {
    lines.push(`# TYPE botpol_${promName(key)} counter`);
    lines.push(`botpol_${promLine(key)} ${value}`);
  }
  for (const [key, value] of Object.entries(snapshot.gauges)) {
    lines.push(`# TYPE botpol_${promName(key)} gauge`);
    lines.push(`botpol_${promLine(key)} ${value}`);
  }
  return `${lines.join("\n")}\n`;
}

function promName(key: string): string {
  return key.replace(/\{.*$/, "").replaceAll(".", "_");
}

function promLine(key: string): string {
  const match = key.match(/^([^{]+)(\{.*\})?$/);
  if (!match) return key.replaceAll(".", "_");
  const name = match[1].replaceAll(".", "_");
  return `${name}${match[2] ?? ""}`;
}
