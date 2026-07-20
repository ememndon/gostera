"use client";

import { useEffect } from "react";
import { useUIStore } from "@/stores/ui-store";
import { CreditCard, KeyRound, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { summarizeRateLimits, formatLimitNumber, formatReset } from "@/lib/rate-limits";

/**
 * Compact header badge showing which Claude credential is active
 * (Subscription vs API key) plus a quick rate-limit hint on hover.
 * Clicking opens the Usage Dashboard, which shows the full breakdown.
 */
export function AuthBadge() {
  const { authMode, setAuthMode, rateLimits, setShowUsageModal } = useUIStore();

  useEffect(() => {
    if (authMode !== "unknown") return;
    let cancelled = false;
    fetch("/api/status")
      .then((r) => r.json())
      .then((d) => { if (!cancelled && d?.mode) setAuthMode(d.mode); })
      .catch(() => { /* leave as unknown */ });
    return () => { cancelled = true; };
  }, [authMode, setAuthMode]);

  if (authMode === "unknown") return null;

  const config = {
    subscription: { label: "Subscription", Icon: CreditCard, cls: "bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25" },
    "api-key":    { label: "API",          Icon: KeyRound,   cls: "bg-primary/15 text-primary hover:bg-primary/25" },
    gemini:       { label: "Gemini free",  Icon: KeyRound,   cls: "bg-blue-500/15 text-blue-400 hover:bg-blue-500/25" },
    none:         { label: "No key",        Icon: AlertTriangle, cls: "bg-red-500/15 text-red-400 hover:bg-red-500/25" },
  }[authMode];

  // Build a terse hover summary from the latest rate-limit snapshot.
  const { rows, retryAfter } = summarizeRateLimits(rateLimits?.limits);
  const tokenRow = rows.find((r) => r.label === "Tokens") ?? rows[0];
  let title = `Claude auth: ${config.label}`;
  if (retryAfter) {
    title += ` · rate limited, retry in ${retryAfter}s`;
  } else if (tokenRow && tokenRow.remaining != null && tokenRow.limit != null) {
    title += ` · ${tokenRow.label.toLowerCase()} ${formatLimitNumber(tokenRow.remaining)}/${formatLimitNumber(tokenRow.limit)} left`;
    const reset = formatReset(tokenRow.reset);
    if (reset) title += ` (resets ${reset})`;
  } else {
    title += " · click for usage";
  }

  const Icon = config.Icon;
  const lowTokens = tokenRow?.pctRemaining != null && tokenRow.pctRemaining <= 10;

  return (
    <button
      onClick={() => setShowUsageModal(true)}
      title={title}
      className={cn(
        "flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded transition-colors",
        config.cls,
        lowTokens && "ring-1 ring-red-500/50"
      )}
    >
      <Icon className="h-3 w-3" />
      {config.label}
      {tokenRow?.pctRemaining != null && !retryAfter && (
        <span className="opacity-70 font-mono">{tokenRow.pctRemaining}%</span>
      )}
      {retryAfter && <span className="opacity-90 font-mono">⏳{retryAfter}s</span>}
    </button>
  );
}
