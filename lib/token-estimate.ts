/**
 * Rough token estimation — ~4 chars per token for English text — plus
 * per-model cost estimation. (F16)
 *
 * Prices are USD per million tokens and follow Anthropic's standard tiers.
 * `cacheRead` is the ~90%-discounted rate charged when a request re-reads a
 * cached prefix; billing cache reads at the full input rate (the old behaviour)
 * materially overstated cost in the dashboard.
 */
const CHARS_PER_TOKEN = 4;

export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

// Keyed by the model ids used across the app (see MODEL_OPTIONS / ALLOWED_MODELS).
const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-haiku-4-5-20251001": { input: 1.0,  output: 5.0,  cacheRead: 0.1,  cacheWrite: 1.25 },
  "claude-sonnet-4-20250514":  { input: 3.0,  output: 15.0, cacheRead: 0.3,  cacheWrite: 3.75 },
  "claude-sonnet-4-6":         { input: 3.0,  output: 15.0, cacheRead: 0.3,  cacheWrite: 3.75 },
  // Opus 4.8 is $5/$25 per MTok (the older Opus 4.0/4.1 tier was $15/$75 —
  // using that here overstated every Opus run cost 3×).
  "claude-opus-4-8":           { input: 5.0,  output: 25.0, cacheRead: 0.5,  cacheWrite: 6.25 },
  // Gemini free tier — $0 (rate-limited: ~15 req/min, 1,500 req/day).
  "gemini-3.5-flash":          { input: 0,    output: 0,    cacheRead: 0,    cacheWrite: 0 },
};

// Fallback when the model is unknown — Sonnet tier (the app default).
const DEFAULT_PRICING: ModelPricing = MODEL_PRICING["claude-sonnet-4-6"];

export function pricingForModel(model?: string): ModelPricing {
  return (model && MODEL_PRICING[model]) || DEFAULT_PRICING;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Estimate the USD cost of a request/run.
 *
 * @param inputTokens   uncached input tokens (billed at the input rate)
 * @param outputTokens  output tokens
 * @param model         model id — selects the pricing tier (defaults to Sonnet)
 * @param cacheReadTokens  tokens served from cache, billed at the (much lower)
 *                         cache-read rate. Pass 0 (default) if unknown.
 */
export function estimateCost(
  inputTokens: number,
  outputTokens: number,
  model?: string,
  cacheReadTokens = 0
): number {
  const p = pricingForModel(model);
  return (
    (inputTokens / 1_000_000) * p.input +
    (outputTokens / 1_000_000) * p.output +
    (cacheReadTokens / 1_000_000) * p.cacheRead
  );
}

export function formatCost(usd: number): string {
  if (usd < 0.001) return "<$0.001";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

export function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}
