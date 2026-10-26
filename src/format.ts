export type Tone = "good" | "warn" | "bad" | "muted";

export function tone(n: number | null): Tone {
  if (n == null || !Number.isFinite(n)) return "muted";
  if (n < 30) return "good";
  if (n <= 60) return "warn";
  return "bad";
}

export function jitterTone(jitter: number, baseline: number | null): Tone {
  if (baseline == null || !Number.isFinite(baseline) || baseline <= 0) return "muted";
  const ratio = jitter / baseline;
  if (ratio < 0.1) return "good";
  if (ratio <= 0.25) return "warn";
  return "bad";
}

export function lossTone(loss: number): Tone {
  if (loss < 1) return "good";
  if (loss <= 5) return "warn";
  return "bad";
}

export function stabilityTone(stability: number): Tone {
  if (stability > 90) return "good";
  if (stability >= 75) return "warn";
  return "bad";
}

export function ms(n: number | null, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return digits ? n.toFixed(digits) : String(Math.round(n));
}

export function pct(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${n >= 10 ? n.toFixed(0) : n.toFixed(1)}%`;
}

export function clock(value: number): string {
  const total = Math.max(0, Math.round(value / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes <= 0) return `${total}s`;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
