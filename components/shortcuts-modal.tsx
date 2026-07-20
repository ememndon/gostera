"use client";

import { Button } from "@/components/ui/button";
import { X } from "lucide-react";

const SHORTCUTS = [
  { keys: ["Ctrl", "Enter"], description: "Send prompt" },
  { keys: ["Ctrl", "B"], description: "Toggle sidebar" },
  { keys: ["Ctrl", "J"], description: "Toggle code editor" },
  { keys: ["Ctrl", "D"], description: "Toggle Build / Discuss mode" },
  { keys: ["Ctrl", "E"], description: "Export project as .zip" },
  { keys: ["Ctrl", "S"], description: "Save project (auto-saves)" },
  { keys: ["?"], description: "Show this shortcuts guide" },
  { keys: ["Esc"], description: "Close modals / cancel rename" },
];

interface Props {
  onClose: () => void;
}

export function ShortcutsModal({ onClose }: Props) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-sm mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-sm font-semibold">Keyboard Shortcuts</h2>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="p-5 space-y-2">
          {SHORTCUTS.map(({ keys, description }) => (
            <div key={description} className="flex items-center justify-between gap-4">
              <span className="text-sm text-muted-foreground">{description}</span>
              <div className="flex items-center gap-1 shrink-0">
                {keys.map((k, i) => (
                  <span key={i} className="flex items-center gap-1">
                    <kbd className="px-2 py-0.5 text-xs font-mono bg-muted border border-border rounded">
                      {k}
                    </kbd>
                    {i < keys.length - 1 && (
                      <span className="text-muted-foreground text-xs">+</span>
                    )}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="px-5 py-3 border-t border-border bg-muted/20">
          <p className="text-xs text-muted-foreground">
            On Mac, use <kbd className="px-1 py-0.5 text-[10px] font-mono bg-muted border border-border rounded">⌘</kbd> instead of <kbd className="px-1 py-0.5 text-[10px] font-mono bg-muted border border-border rounded">Ctrl</kbd>
          </p>
        </div>
      </div>
    </div>
  );
}
