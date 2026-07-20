/**
 * Anthropic client factory — supports BOTH a Claude subscription (Pro/Max)
 * and a pay-per-token API key, with the subscription taking precedence.
 *
 * Auth precedence:
 *   1. CLAUDE_CODE_OAUTH_TOKEN  → use the Claude subscription (no API billing).
 *      Generate the token once with `claude setup-token` (requires Claude Code
 *      installed and an active Pro/Max plan). Draws from your subscription's
 *      rate limits instead of a metered API account.
 *   2. ANTHROPIC_API_KEY        → fall back to the standard metered API.
 *
 * How subscription auth works here:
 *   The OAuth token authenticates against the same Messages API, but via an
 *   `Authorization: Bearer <token>` header (not `x-api-key`) plus the
 *   `anthropic-beta: oauth-2025-04-20` header. Requests in this mode must also
 *   begin their system prompt with the Claude Code identity line — see
 *   `withIdentitySystem()` below, which every route must use when mode is
 *   "subscription".
 *
 * NOTE: this is the OAuth-token-against-the-Messages-API approach (the same
 * transport Claude Code uses). It is not an officially documented use of the
 * raw SDK and could change; the API-key path remains the supported fallback.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { RateLimits } from "./rate-limits";

/** Beta header required for OAuth (subscription) requests. */
const OAUTH_BETA_HEADER = "oauth-2025-04-20";

/**
 * Required first line of the system prompt when using a subscription token.
 * The Messages API rejects OAuth requests whose system prompt does not begin
 * with this exact Claude Code identity string.
 */
export const CLAUDE_CODE_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude.";

export type AuthMode = "subscription" | "api-key";

export interface ResolvedAuth {
  client: Anthropic;
  mode: AuthMode;
}

/**
 * Pull every rate-limit-related header out of an API Response into a plain map.
 * Captures `anthropic-ratelimit-*` (incl. any `unified-*` subscription buckets)
 * and `retry-after`. Returns {} when no such headers are present.
 */
export function extractRateLimits(headers: Headers | undefined | null): RateLimits {
  const out: RateLimits = {};
  if (!headers) return out;
  headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (k.startsWith("anthropic-ratelimit-") || k === "retry-after") {
      out[k] = value;
    }
  });
  return out;
}

/** Resolve just the auth mode without constructing a client (for status checks). */
export function currentAuthMode(): "subscription" | "api-key" | "none" {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return "subscription";
  if (process.env.ANTHROPIC_API_KEY?.trim()) return "api-key";
  return "none";
}

/**
 * Build an Anthropic client from whichever credential is configured.
 * Returns `{ error }` (a user-facing message) when neither is set.
 */
export function resolveAnthropic(): ResolvedAuth | { error: string } {
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();

  if (oauthToken) {
    const client = new Anthropic({
      apiKey: null,
      authToken: oauthToken,
      defaultHeaders: { "anthropic-beta": OAUTH_BETA_HEADER },
    });
    return { client, mode: "subscription" };
  }

  if (apiKey) {
    return { client: new Anthropic({ apiKey }), mode: "api-key" };
  }

  return {
    error:
      "No Claude credentials configured. Set CLAUDE_CODE_OAUTH_TOKEN " +
      "(Claude subscription — run `claude setup-token`) or ANTHROPIC_API_KEY " +
      "in .env.local.",
  };
}

/**
 * Turn an Anthropic SDK error into an actionable, user-facing message.
 * Without this, an expired OAuth token surfaced as an opaque 500 /
 * "Generation failed" with no hint that the fix is regenerating the token.
 */
export function describeAnthropicError(err: unknown, mode: AuthMode): { message: string; status: number } {
  const status = (err as { status?: number })?.status;
  if (status === 401) {
    return {
      status: 401,
      message:
        mode === "subscription"
          ? "Claude rejected your credential (401 — invalid bearer token). Your CLAUDE_CODE_OAUTH_TOKEN has expired or been revoked: run `claude setup-token` in a terminal, paste the new token into .env.local, and restart the dev server. (Or set ANTHROPIC_API_KEY and remove the OAuth token to use metered API billing.)"
          : "Claude rejected your API key (401). Check ANTHROPIC_API_KEY in .env.local and restart the dev server.",
    };
  }
  if (status === 404) {
    return { status: 404, message: "Model not found (404) — it may have been retired. Pick a different model in the model picker." };
  }
  if (status === 429) {
    return { status: 429, message: "Rate limit reached (429). Wait a moment and try again." };
  }
  const msg = err instanceof Error ? err.message : "Unknown error";
  return { status: 502, message: `Claude API error${status ? ` (${status})` : ""}: ${msg}` };
}

/**
 * Ensure the system prompt carries the Claude Code identity as its FIRST
 * block when running in subscription mode. In api-key mode the prompt is
 * returned unchanged.
 *
 * Accepts either a plain string or an array of text blocks (so callers using
 * prompt-cache breakpoints keep their cache_control intact — the identity is
 * prepended as a separate, uncached block).
 */
export function withIdentitySystem(
  system: string | Anthropic.TextBlockParam[],
  mode: AuthMode
): string | Anthropic.TextBlockParam[] {
  if (mode !== "subscription") return system;

  const identityBlock: Anthropic.TextBlockParam = {
    type: "text",
    text: CLAUDE_CODE_IDENTITY,
  };

  if (typeof system === "string") {
    return [identityBlock, { type: "text", text: system }];
  }
  return [identityBlock, ...system];
}
