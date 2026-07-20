/**
 * Rate-limit helpers shared between server routes and UI.
 *
 * Anthropic returns usage/limit info as response headers prefixed with
 * `anthropic-ratelimit-` (plus `retry-after` when throttled). We capture them
 * verbatim rather than hardcoding header names, because subscription (OAuth)
 * requests may surface different/`unified` buckets than metered API keys.
 */

export type AuthMode = "subscription" | "api-key" | "gemini" | "none" | "unknown";

/** Raw header name → value, e.g. { "anthropic-ratelimit-tokens-remaining": "780000" } */
export type RateLimits = Record<string, string>;

export interface RateLimitTrailer {
  mode: AuthMode;
  limits: RateLimits;
  /** Epoch ms when captured (so the UI can show "as of …"). */
  capturedAt: number;
}

export interface RateLimitRow {
  /** Human label, e.g. "Tokens", "Requests", "Input tokens". */
  label: string;
  remaining?: number;
  limit?: number;
  /** ISO timestamp string when this bucket resets, if provided. */
  reset?: string;
  /** Percentage of the bucket still available (0–100), when both numbers exist. */
  pctRemaining?: number;
}

const PREFIX = "anthropic-ratelimit-";
const FIELDS = new Set(["limit", "remaining", "reset"]);

function titleCase(base: string): string {
  return base
    .split("-")
    .map((w) => (w === "tokens" ? "tokens" : w))
    .join(" ")
    .replace(/^\w/, (c) => c.toUpperCase());
}

/**
 * Collapse the flat header map into per-bucket rows
 * (requests, tokens, input-tokens, output-tokens, unified-*, …).
 */
export function summarizeRateLimits(limits: RateLimits | null | undefined): {
  rows: RateLimitRow[];
  retryAfter?: string;
} {
  if (!limits) return { rows: [] };

  const buckets = new Map<string, { limit?: number; remaining?: number; reset?: string }>();
  let retryAfter: string | undefined;

  for (const [rawKey, value] of Object.entries(limits)) {
    const key = rawKey.toLowerCase();
    if (key === "retry-after") {
      retryAfter = value;
      continue;
    }
    if (!key.startsWith(PREFIX)) continue;

    const rest = key.slice(PREFIX.length); // e.g. "tokens-remaining"
    const lastDash = rest.lastIndexOf("-");
    if (lastDash === -1) continue;
    const field = rest.slice(lastDash + 1);
    const base = rest.slice(0, lastDash);
    if (!FIELDS.has(field)) continue;

    const entry = buckets.get(base) ?? {};
    if (field === "reset") entry.reset = value;
    else {
      const n = Number(value);
      if (!Number.isNaN(n)) (entry as Record<string, number>)[field] = n;
    }
    buckets.set(base, entry);
  }

  const rows: RateLimitRow[] = Array.from(buckets.entries()).map(([base, e]) => {
    const pctRemaining =
      e.limit != null && e.limit > 0 && e.remaining != null
        ? Math.max(0, Math.min(100, Math.round((e.remaining / e.limit) * 100)))
        : undefined;
    return { label: titleCase(base), limit: e.limit, remaining: e.remaining, reset: e.reset, pctRemaining };
  });

  // Stable, useful ordering: tokens first, then requests, then the rest.
  const order = (l: string) => (l === "Tokens" ? 0 : l === "Requests" ? 1 : 2);
  rows.sort((a, b) => order(a.label) - order(b.label) || a.label.localeCompare(b.label));

  return { rows, retryAfter };
}

export function formatLimitNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function formatReset(reset?: string): string | undefined {
  if (!reset) return undefined;
  const d = new Date(reset);
  if (Number.isNaN(d.getTime())) return reset;
  const secs = Math.max(0, Math.round((d.getTime() - Date.now()) / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  return `${Math.round(secs / 3600)}h`;
}
