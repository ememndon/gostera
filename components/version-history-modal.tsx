"use client";

import { useState } from "react";
import type { ProjectVersion, ProjectFile } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { X, RotateCcw, GitCompare, ChevronLeft } from "lucide-react";

interface Props {
  versions: ProjectVersion[];
  currentFiles: ProjectFile[];
  onRestore: (v: ProjectVersion) => void;
  onClose: () => void;
}

type DiffLine =
  | { type: "same"; content: string }
  | { type: "added"; content: string }
  | { type: "removed"; content: string };

function computeDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const result: DiffLine[] = [];

  // Simple LCS-based diff
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        dp[i][j] = 1 + dp[i + 1][j + 1];
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  let i = 0, j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      result.push({ type: "same", content: oldLines[i] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ type: "removed", content: oldLines[i] });
      i++;
    } else {
      result.push({ type: "added", content: newLines[j] });
      j++;
    }
  }
  while (i < m) { result.push({ type: "removed", content: oldLines[i++] }); }
  while (j < n) { result.push({ type: "added", content: newLines[j++] }); }

  return result;
}

function DiffView({
  version,
  currentFiles,
  onBack,
}: {
  version: ProjectVersion;
  currentFiles: ProjectFile[];
  onBack: () => void;
}) {
  const [selectedPath, setSelectedPath] = useState<string>(() => {
    return version.files[0]?.path ?? "";
  });

  const versionFile = version.files.find((f) => f.path === selectedPath);
  const currentFile = currentFiles.find((f) => f.path === selectedPath);

  const oldContent = versionFile?.content ?? "";
  const newContent = currentFile?.content ?? "";
  const diff = computeDiff(oldContent, newContent);

  const changedCount = diff.filter((l) => l.type !== "same").length;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
        <button onClick={onBack} className="text-muted-foreground hover:text-foreground">
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="text-sm font-medium">Diff — {new Date(version.createdAt).toLocaleString()}</span>
        {changedCount > 0 && (
          <span className="ml-auto text-xs text-muted-foreground">{changedCount} changed lines</span>
        )}
      </div>

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* File list */}
        <div className="w-36 shrink-0 border-r border-border overflow-y-auto py-1">
          {version.files.map((f) => {
            const cur = currentFiles.find((cf) => cf.path === f.path);
            const changed = cur?.content !== f.content;
            return (
              <button
                key={f.path}
                onClick={() => setSelectedPath(f.path)}
                className={`w-full text-left px-3 py-1.5 text-xs truncate flex items-center gap-1 hover:bg-accent/50 transition-colors ${selectedPath === f.path ? "bg-accent text-accent-foreground font-medium" : "text-muted-foreground"}`}
                title={f.path}
              >
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${changed ? "bg-yellow-400" : "bg-muted-foreground/30"}`} />
                <span className="truncate">{f.path.split("/").pop()}</span>
              </button>
            );
          })}
        </div>

        {/* Diff content */}
        <div className="flex-1 overflow-auto scrollbar-thin">
          {changedCount === 0 && versionFile ? (
            <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
              No changes in this file
            </div>
          ) : (
            <table className="w-full text-[11px] font-mono leading-5 border-collapse">
              <tbody>
                {diff.map((line, idx) => (
                  <tr
                    key={idx}
                    className={
                      line.type === "added"
                        ? "bg-green-500/10"
                        : line.type === "removed"
                        ? "bg-red-500/10"
                        : ""
                    }
                  >
                    <td className="select-none w-6 text-center text-muted-foreground/40 border-r border-border/30 px-1">
                      {line.type === "added" ? "+" : line.type === "removed" ? "−" : " "}
                    </td>
                    <td
                      className={`px-3 py-0 whitespace-pre ${
                        line.type === "added"
                          ? "text-green-400"
                          : line.type === "removed"
                          ? "text-red-400"
                          : "text-foreground/70"
                      }`}
                    >
                      {line.content}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

export function VersionHistoryModal({ versions, currentFiles, onRestore, onClose }: Props) {
  const [diffVersion, setDiffVersion] = useState<ProjectVersion | null>(null);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-2xl mx-4 overflow-hidden flex flex-col" style={{ maxHeight: "80vh" }}>
        {diffVersion ? (
          <>
            <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
              <h2 className="text-sm font-semibold">Version History</h2>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex-1 min-h-0 overflow-hidden" style={{ minHeight: 300 }}>
              <DiffView
                version={diffVersion}
                currentFiles={currentFiles}
                onBack={() => setDiffVersion(null)}
              />
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
              <h2 className="text-sm font-semibold">Version History</h2>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="flex-1 overflow-y-auto scrollbar-thin divide-y divide-border">
              {versions.length === 0 ? (
                <p className="text-sm text-muted-foreground p-4">No versions saved yet.</p>
              ) : (
                versions.map((v, i) => (
                  <div key={v.id} className="flex items-center justify-between px-4 py-3 hover:bg-accent/50 transition-colors">
                    <div>
                      <p className="text-sm font-medium">
                        {i === 0 ? "Previous version" : `Version ${versions.length - i}`}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(v.createdAt).toLocaleString()} · {v.files.length} files
                      </p>
                      {v.description && (
                        <p className="text-xs text-muted-foreground/70 truncate max-w-xs">{v.description}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs gap-1"
                        onClick={() => setDiffVersion(v)}
                        title="View diff vs. current"
                      >
                        <GitCompare className="h-3 w-3" /> Diff
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs gap-1"
                        onClick={() => onRestore(v)}
                      >
                        <RotateCcw className="h-3 w-3" /> Restore
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="px-4 py-3 border-t border-border bg-muted/30 shrink-0">
              <p className="text-xs text-muted-foreground">
                Restoring a version replaces the current files. Last 10 versions are kept.
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
