"use client";

import { useProjectStore } from "@/stores/project-store";
import { useUIStore } from "@/stores/ui-store";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Download, Globe, Sun, Moon, Pencil, History, Keyboard, Share2, Settings, RotateCcw, AlertTriangle } from "lucide-react";
import { useTheme } from "next-themes";
import { useState, useRef, useEffect } from "react";
import { exportAsZip } from "@/lib/export";
import { VersionHistoryModal } from "@/components/version-history-modal";
import { GithubModal } from "@/components/github-modal";
import { cn } from "@/lib/utils";
function GithubIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
    </svg>
  );
}

interface Props {
  onShowShortcuts?: () => void;
}

const TOP_TABS = [
  { id: "dashboard", label: "Dashboard" },
  { id: "templates", label: "Templates" },
] as const;

export function TopBar({ onShowShortcuts }: Props) {
  const { currentProject, updateProjectName, versions, restoreVersion, syncError, clearSyncError } = useProjectStore();
  const { theme, setTheme } = useTheme();
  const { activeTopTab, setActiveTopTab } = useUIStore();
  const [editing, setEditing] = useState(false);
  const [nameVal, setNameVal] = useState("");
  const [mounted, setMounted] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [showGithub, setShowGithub] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (editing) {
      setNameVal(currentProject?.name ?? "");
      setTimeout(() => inputRef.current?.select(), 0);
    }
  }, [editing, currentProject?.name]);

  // Handle GitHub connection result from OAuth redirect
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const githubParam = params.get("github");
    if (githubParam === "connected") {
      setShowGithub(true);
      // Clean up the URL
      const url = new URL(window.location.href);
      url.searchParams.delete("github");
      window.history.replaceState({}, "", url.toString());
    }
  }, []);

  const commitRename = () => {
    if (nameVal.trim()) updateProjectName(nameVal.trim());
    setEditing(false);
  };

  const handleExport = async () => {
    if (!currentProject || currentProject.files.length === 0) return;
    setExporting(true);
    try {
      await exportAsZip(currentProject.name, currentProject.files);
    } finally {
      setExporting(false);
    }
  };

  const handleShare = () => {
    navigator.clipboard.writeText(window.location.href).then(() => {
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2000);
    });
  };

  return (
    <>
      <header className="flex items-center h-12 border-b border-border bg-card shrink-0 px-0">
        {/* Brand */}
        <div className="flex items-center gap-0 h-full border-r border-border px-4">
          <span className="text-sm font-bold text-primary tracking-tight">Gostera</span>
        </div>

        {/* Project name */}
        <div className="flex items-center gap-2 px-4 border-r border-border h-full">
          {editing ? (
            <input
              ref={inputRef}
              value={nameVal}
              onChange={(e) => setNameVal(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") setEditing(false);
              }}
              className="bg-transparent border-b border-primary text-sm font-medium outline-none px-1 w-40"
            />
          ) : (
            <button
              onClick={() => currentProject && setEditing(true)}
              className="flex items-center gap-1.5 text-sm font-medium hover:text-primary transition-colors max-w-44"
            >
              <span className="truncate">{currentProject?.name ?? "Gostera Studio"}</span>
              {currentProject && <Pencil className="h-3 w-3 shrink-0 opacity-40" />}
            </button>
          )}
        </div>

        {/* Disk sync failure indicator (F13) */}
        {syncError && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={clearSyncError}
                className="flex items-center gap-1.5 px-3 h-full border-r border-border text-amber-500 hover:text-amber-400 transition-colors"
              >
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span className="text-xs font-medium">Disk sync failed</span>
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {syncError} — the editor may be ahead of what&apos;s on disk. Click to dismiss; re-run to retry the sync.
            </TooltipContent>
          </Tooltip>
        )}

        {/* Center tabs */}
        <nav className="flex items-end h-full px-2">
          {TOP_TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => {
                setActiveTopTab(tab.id);
                if (tab.id === "templates") useUIStore.getState().setOpenTemplates(true);
              }}
              className={cn(
                "px-4 h-full text-sm font-medium transition-colors relative",
                activeTopTab === tab.id
                  ? "text-primary"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {tab.label}
              {activeTopTab === tab.id && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-t" />
              )}
            </button>
          ))}
        </nav>

        {/* Right actions */}
        <div className="flex items-center gap-1 ml-auto px-3">
          {/* Theme */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-foreground"
                onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              >
                {mounted && theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Toggle theme</TooltipContent>
          </Tooltip>

          {/* Version history */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-foreground"
                onClick={() => versions.length > 0 && setShowVersions(true)}
              >
                <RotateCcw className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {versions.length > 0 ? `${versions.length} version${versions.length !== 1 ? "s" : ""}` : "No versions yet"}
            </TooltipContent>
          </Tooltip>

          {/* Settings / Shortcuts */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-foreground"
                onClick={onShowShortcuts}
              >
                <Settings className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Settings / Shortcuts (?)</TooltipContent>
          </Tooltip>

          {/* GitHub push */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-foreground"
                onClick={() => setShowGithub(true)}
                disabled={!currentProject || currentProject.files.length === 0}
              >
                <GithubIcon className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Push to GitHub</TooltipContent>
          </Tooltip>

          {/* Share */}
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs font-medium gap-1.5 border-border text-muted-foreground hover:text-foreground"
            onClick={handleShare}
          >
            <Share2 className="h-3.5 w-3.5" />
            {shareCopied ? "Copied!" : "Share"}
          </Button>

          {/* Export */}
          <Button
            size="sm"
            className="h-8 text-xs font-semibold gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90 cyan-glow"
            disabled={!currentProject || currentProject.files.length === 0 || exporting}
            onClick={handleExport}
          >
            <Download className={`h-3.5 w-3.5 ${exporting ? "animate-pulse" : ""}`} />
            Export
          </Button>
        </div>
      </header>

      {showVersions && (
        <VersionHistoryModal
          versions={versions}
          currentFiles={currentProject?.files ?? []}
          onRestore={(v) => {
            restoreVersion(v);
            setShowVersions(false);
          }}
          onClose={() => setShowVersions(false)}
        />
      )}

      {showGithub && currentProject && (
        <GithubModal
          projectName={currentProject.name}
          files={currentProject.files}
          onClose={() => setShowGithub(false)}
        />
      )}
    </>
  );
}
