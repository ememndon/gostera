"use client";

import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";

/**
 * Single-tab guard. (F8)
 *
 * The project store is zustand-persist over IndexedDB: every set() rewrites the
 * ENTIRE state object, and there is no cross-tab reconciliation. Two open tabs
 * therefore silently clobber each other — the second tab's first write persists
 * its stale snapshot over everything the first tab did.
 *
 * Until state moves to per-entity storage (or a real DB), enforce one tab at a
 * time: the first tab acquires a Web Lock and holds it for its lifetime; any
 * later tab fails `ifAvailable` acquisition and shows a blocking overlay.
 * Closing the primary tab releases the lock automatically, and waiting tabs
 * detect this and reload into the primary role.
 */
export function SingleTabGuard() {
  // null = still checking, true = we hold the lock, false = another tab does
  const [isPrimary, setIsPrimary] = useState<boolean | null>(null);

  useEffect(() => {
    // Older browsers without Web Locks: fail open (previous behaviour).
    if (typeof navigator === "undefined" || !("locks" in navigator)) {
      setIsPrimary(true);
      return;
    }

    let cancelled = false;
    let releaseHeldLock: (() => void) | null = null;

    // Hold the lock until the effect is torn down. If teardown already
    // happened by the time the lock is granted (React StrictMode runs
    // mount→cleanup→mount in dev, and cleanup can beat the async grant),
    // release immediately — otherwise a dead effect would hold the lock
    // forever and the REAL effect's tab would falsely see "another tab".
    const holdWhileMounted = (): Promise<void> | void => {
      if (cancelled) return; // returning void releases the lock at once
      return new Promise<void>((resolve) => { releaseHeldLock = resolve; });
    };

    navigator.locks.request("gostera-primary-tab", { ifAvailable: true }, (lock) => {
      if (cancelled) return;
      if (lock === null) {
        // Another tab holds it. Show the overlay, then queue a normal (waiting)
        // request — it resolves when the primary tab closes, and we take over.
        setIsPrimary(false);
        return navigator.locks.request("gostera-primary-tab", () => {
          if (!cancelled) setIsPrimary(true);
          return holdWhileMounted();
        });
      }
      setIsPrimary(true);
      return holdWhileMounted();
    });

    return () => {
      cancelled = true;
      releaseHeldLock?.();
    };
  }, []);

  if (isPrimary !== false) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background">
      <div className="max-w-sm mx-4 text-center space-y-4">
        <div className="w-14 h-14 rounded-full bg-yellow-500/10 border border-yellow-500/30 flex items-center justify-center mx-auto">
          <AlertTriangle className="h-6 w-6 text-yellow-400" />
        </div>
        <div>
          <p className="text-sm font-semibold text-foreground">
            Gostera is already open in another tab
          </p>
          <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
            Projects are stored locally, and two tabs writing at once would
            overwrite each other&apos;s changes. Close the other tab and this
            one will take over automatically.
          </p>
        </div>
      </div>
    </div>
  );
}
