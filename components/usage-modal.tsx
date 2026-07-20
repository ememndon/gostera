"use client";

import { useProjectStore } from "@/stores/project-store";
import { useUIStore } from "@/stores/ui-store";
import { Button } from "@/components/ui/button";
import { X, Zap, BarChart3, DollarSign, Hash, CreditCard, KeyRound, Gauge } from "lucide-react";
import { formatCost } from "@/lib/token-estimate";
import { summarizeRateLimits, formatLimitNumber, formatReset } from "@/lib/rate-limits";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

const FRAMEWORK_ICONS: Record<string, string> = {
  "nextjs": "▲", "react-vite": "⚛", "html-css-js": "🌐",
  "node-express": "🟢", "python-flask": "🐍", "vuejs": "💚", "svelte": "🔶",
};

export function UsageModal() {
  const { generationLogs } = useProjectStore();
  const { setShowUsageModal, authMode, rateLimits } = useUIStore();

  const isSubscription = authMode === "subscription";
  const { rows: rlRows, retryAfter } = summarizeRateLimits(rateLimits?.limits);

  const totalGenerations = generationLogs.length;
  const totalIn = generationLogs.reduce((a, l) => a + l.tokensInput, 0);
  const totalOut = generationLogs.reduce((a, l) => a + l.tokensOutput, 0);
  const totalCost = generationLogs.reduce((a, l) => a + l.cost, 0);

  // Per-framework breakdown
  const byFramework = generationLogs.reduce<Record<string, { count: number; cost: number }>>(
    (acc, l) => {
      if (!acc[l.framework]) acc[l.framework] = { count: 0, cost: 0 };
      acc[l.framework].count++;
      acc[l.framework].cost += l.cost;
      return acc;
    },
    {}
  );

  const frameworkEntries = Object.entries(byFramework).sort((a, b) => b[1].count - a[1].count);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold">Usage Dashboard</h2>
          </div>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setShowUsageModal(false)}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="p-4 space-y-4">
          {/* Stats grid */}
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-muted/40 rounded-lg p-3 border border-border/60">
              <div className="flex items-center gap-1.5 mb-1">
                <Hash className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">Generations</span>
              </div>
              <p className="text-2xl font-bold text-foreground">{totalGenerations.toLocaleString()}</p>
            </div>

            <div className="bg-muted/40 rounded-lg p-3 border border-border/60">
              <div className="flex items-center gap-1.5 mb-1">
                <DollarSign className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">Total Cost</span>
              </div>
              <p className="text-2xl font-bold text-foreground">{formatCost(totalCost)}</p>
            </div>

            <div className="bg-muted/40 rounded-lg p-3 border border-border/60">
              <div className="flex items-center gap-1.5 mb-1">
                <Zap className="h-3.5 w-3.5 text-primary/70" />
                <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">Input Tokens</span>
              </div>
              <p className="text-2xl font-bold text-foreground">{formatTokens(totalIn)}</p>
            </div>

            <div className="bg-muted/40 rounded-lg p-3 border border-border/60">
              <div className="flex items-center gap-1.5 mb-1">
                <Zap className="h-3.5 w-3.5 text-primary/70" />
                <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">Output Tokens</span>
              </div>
              <p className="text-2xl font-bold text-foreground">{formatTokens(totalOut)}</p>
            </div>
          </div>

          {/* Claude credential + rate limits */}
          <div className="rounded-lg border border-border/60 bg-muted/40 p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-1.5">
                <Gauge className="h-3.5 w-3.5 text-primary/70" />
                <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">
                  Claude Credential
                </span>
              </div>
              <span
                className={
                  "flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded " +
                  (isSubscription
                    ? "bg-emerald-500/15 text-emerald-400"
                    : authMode === "api-key"
                    ? "bg-primary/15 text-primary"
                    : "bg-red-500/15 text-red-400")
                }
              >
                {isSubscription ? (
                  <><CreditCard className="h-3 w-3" /> Subscription</>
                ) : authMode === "api-key" ? (
                  <><KeyRound className="h-3 w-3" /> API key</>
                ) : (
                  "Not configured"
                )}
              </span>
            </div>

            {retryAfter && (
              <p className="text-[11px] text-red-400 mb-2">
                Rate limited — retry in {retryAfter}s.
              </p>
            )}

            {rlRows.length > 0 ? (
              <div className="space-y-2">
                {rlRows.map((r) => (
                  <div key={r.label}>
                    <div className="flex items-center justify-between text-[11px] mb-0.5">
                      <span className="text-foreground">{r.label}</span>
                      <span className="text-muted-foreground font-mono">
                        {r.remaining != null && r.limit != null
                          ? `${formatLimitNumber(r.remaining)} / ${formatLimitNumber(r.limit)} left`
                          : r.remaining != null
                          ? `${formatLimitNumber(r.remaining)} left`
                          : "—"}
                        {formatReset(r.reset) ? ` · resets ${formatReset(r.reset)}` : ""}
                      </span>
                    </div>
                    {r.pctRemaining != null && (
                      <div className="h-1.5 w-full rounded-full bg-border/60 overflow-hidden">
                        <div
                          className={
                            "h-full rounded-full " +
                            (r.pctRemaining <= 10
                              ? "bg-red-500"
                              : r.pctRemaining <= 30
                              ? "bg-amber-500"
                              : "bg-emerald-500")
                          }
                          style={{ width: `${r.pctRemaining}%` }}
                        />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                No rate-limit data yet — run a generation to populate it.
              </p>
            )}

            {isSubscription && (
              <p className="text-[10px] text-muted-foreground/70 mt-2 leading-relaxed">
                On a subscription, usage draws from your plan&apos;s rate limits — the
                cost figures above are estimates only and are <strong>not</strong> billed per token.
              </p>
            )}
          </div>

          {/* Framework breakdown */}
          {frameworkEntries.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-2">By Framework</p>
              <div className="space-y-1.5">
                {frameworkEntries.map(([fw, stats]) => (
                  <div key={fw} className="flex items-center gap-2 text-xs">
                    <span className="w-5 text-center">{FRAMEWORK_ICONS[fw] ?? "📦"}</span>
                    <span className="flex-1 text-foreground capitalize">{fw.replace("-", " / ")}</span>
                    <span className="text-muted-foreground">{stats.count} gen{stats.count !== 1 ? "s" : ""}</span>
                    <span className="text-primary font-mono w-14 text-right">{formatCost(stats.cost)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Recent logs */}
          {generationLogs.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-2">Recent Generations</p>
              <div className="space-y-1.5 max-h-40 overflow-y-auto scrollbar-thin">
                {generationLogs.slice(0, 20).map((log) => (
                  <div key={log.id} className="flex items-start gap-2 text-xs py-1.5 border-b border-border/30 last:border-0">
                    <span className="w-5 text-center shrink-0">{FRAMEWORK_ICONS[log.framework] ?? "📦"}</span>
                    <span className="flex-1 text-muted-foreground truncate">{log.prompt}</span>
                    <div className="shrink-0 text-right space-y-0.5">
                      <p className="text-primary font-mono text-[10px]">{formatCost(log.cost)}</p>
                      <p className="text-muted-foreground/60 text-[10px]">
                        {new Date(log.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {generationLogs.length === 0 && (
            <div className="text-center py-6 text-muted-foreground text-sm">
              No generation history yet. Build something to see usage stats!
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t border-border bg-muted/30">
          <p className="text-xs text-muted-foreground">
            Usage data is stored locally in your browser. Up to 500 recent generations are tracked.
          </p>
        </div>
      </div>
    </div>
  );
}
