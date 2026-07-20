"use client";

import { useState } from "react";
import { useUIStore } from "@/stores/ui-store";
import { Sidebar } from "@/components/sidebar";
import { TopBar } from "@/components/top-bar";
import { ChatPanel } from "@/components/chat-panel";
import { PreviewPanel } from "@/components/preview-panel";
import { CodePanel } from "@/components/code-panel";
import { WelcomeScreen } from "@/components/welcome-screen";
import { ShortcutsModal } from "@/components/shortcuts-modal";
import { SmallScreenWarning } from "@/components/small-screen-warning";
import { SingleTabGuard } from "@/components/single-tab-guard";
import { UsageModal } from "@/components/usage-modal";
import { ImportModal } from "@/components/import-modal";
import { useProjectStore } from "@/stores/project-store";
import { useUIKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { useEffect } from "react";

export function AppLayout() {
  const { currentProject } = useProjectStore();
  const { previewFullscreen, showUsageModal } = useUIStore();
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showImport, setShowImport] = useState(false);

  useUIKeyboardShortcuts();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "?") setShowShortcuts(true);
      if (e.key === "Escape") setShowShortcuts(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <>
      <SingleTabGuard />
      <SmallScreenWarning />

      <div className="flex h-screen w-full overflow-hidden bg-background text-foreground">
        <Sidebar onImport={() => setShowImport(true)} />

        <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
          <TopBar onShowShortcuts={() => setShowShortcuts(true)} />

          {!currentProject ? (
            <WelcomeScreen onImport={() => setShowImport(true)} />
          ) : (
            <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
              <div className="flex flex-1 min-h-0 overflow-hidden">
                {!previewFullscreen && (
                  <div className="border-r border-border overflow-hidden shrink-0" style={{ flex: "1.2 1 0", minWidth: 280, maxWidth: 520 }}>
                    <ChatPanel />
                  </div>
                )}
                <div className="overflow-hidden" style={{ flex: previewFullscreen ? "1 1 0" : "2 1 0", minWidth: 320 }}>
                  <PreviewPanel />
                </div>
              </div>
              <CodePanel />
            </div>
          )}
        </div>
      </div>

      {showShortcuts && <ShortcutsModal onClose={() => setShowShortcuts(false)} />}
      {showUsageModal && <UsageModal />}
      {showImport && <ImportModal onClose={() => setShowImport(false)} />}
    </>
  );
}
