"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useUIStore } from "@/stores/ui-store";
import { useProjectStore } from "@/stores/project-store";
import { Button } from "@/components/ui/button";
import {
  ChevronUp,
  ChevronDown,
  Copy,
  Check,
  FileCode,
  Download,
  Pencil,
  Save,
  X,
  Search,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";

// Map file extensions to highlight.js language names
function getLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    py: "python", html: "html", css: "css", scss: "scss",
    json: "json", md: "markdown", sh: "bash", bash: "bash",
    yaml: "yaml", yml: "yaml", toml: "ini", xml: "xml",
    go: "go", rs: "rust", java: "java", c: "c", cpp: "cpp", h: "c",
    vue: "html", svelte: "html", sql: "sql", env: "ini",
  };
  return map[ext] ?? "plaintext";
}

// Highlight code using highlight.js loaded lazily
let hljsPromise: Promise<typeof import("highlight.js").default> | null = null;
function getHljs() {
  if (!hljsPromise) {
    hljsPromise = import("highlight.js").then((m) => m.default);
  }
  return hljsPromise;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function CodePanel() {
  const { codeEditorOpen, toggleCodeEditor, activeFile, setActiveFile } = useUIStore();
  const { currentProject, updateFileContent } = useProjectStore();
  const [copied, setCopied] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);
  const [panelHeight, setPanelHeight] = useState(272);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMatchIndex, setSearchMatchIndex] = useState(0);
  const [searchMatchCount, setSearchMatchCount] = useState(0);

  const isDragging = useRef(false);
  const dragStartY = useRef(0);
  const dragStartHeight = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLDivElement>(null);

  const files = currentProject?.files ?? [];

  useEffect(() => {
    if (files.length > 0 && (!activeFile || !files.find((f) => f.path === activeFile))) {
      setActiveFile(files[0].path);
    }
  }, [files, activeFile, setActiveFile]);

  const currentFile = files.find((f) => f.path === activeFile) ?? null;

  // Syntax highlight whenever file changes
  useEffect(() => {
    if (!currentFile || editMode) return;
    setHighlightedHtml(null);
    // Very large files: skip tokenization — highlight.js on a multi-hundred-KB
    // file blocks the main thread for seconds. Plain escaped text instead. (L3)
    if (currentFile.content.length > 200_000) {
      setHighlightedHtml(escapeHtml(currentFile.content));
      return;
    }
    const lang = getLanguage(currentFile.path);
    getHljs().then((hljs) => {
      try {
        const result = hljs.highlight(currentFile.content, { language: lang, ignoreIllegals: true });
        setHighlightedHtml(result.value);
      } catch {
        setHighlightedHtml(escapeHtml(currentFile.content));
      }
    });
  }, [currentFile, editMode]);

  // Search: count matches and highlight
  useEffect(() => {
    if (!searchQuery || !currentFile) {
      setSearchMatchCount(0);
      setSearchMatchIndex(0);
      return;
    }
    try {
      const regex = new RegExp(searchQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      const matches = Array.from(currentFile.content.matchAll(regex));
      setSearchMatchCount(matches.length);
      setSearchMatchIndex((i) => Math.min(i, Math.max(0, matches.length - 1)));
    } catch {
      setSearchMatchCount(0);
    }
  }, [searchQuery, currentFile]);

  const highlightedWithSearch = useCallback((): string => {
    if (!searchQuery || !highlightedHtml) return highlightedHtml ?? "";
    try {
      // Apply search highlights on top of syntax-highlighted HTML
      // We work on the plain text to find positions, then mark spans
      const plain = currentFile?.content ?? "";
      const regex = new RegExp(searchQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      const matches = Array.from(plain.matchAll(regex));
      if (!matches.length) return highlightedHtml;

      // Re-highlight with search markers embedded by escaping the match positions
      // Simpler: just mark the raw highlighted HTML by replacing visible text segments
      // Because highlighted HTML has tags, do it on the source with a two-pass approach
      let idx = 0;
      return plain.replace(regex, (match) => {
        const cls =
          idx++ === searchMatchIndex
            ? "bg-yellow-400 text-black rounded"
            : "bg-yellow-400/40 text-foreground rounded";
        return `<mark class="${cls}">${escapeHtml(match)}</mark>`;
      });
    } catch {
      return highlightedHtml ?? "";
    }
  }, [searchQuery, highlightedHtml, currentFile, searchMatchIndex]);

  // Drag-to-resize
  const handleDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    dragStartY.current = e.clientY;
    dragStartHeight.current = panelHeight;

    const onMove = (ev: MouseEvent) => {
      if (!isDragging.current) return;
      const delta = dragStartY.current - ev.clientY;
      setPanelHeight(Math.max(120, Math.min(700, dragStartHeight.current + delta)));
    };
    const onUp = () => {
      isDragging.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const handleCopy = () => {
    if (!currentFile) return;
    navigator.clipboard.writeText(currentFile.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadFile = () => {
    if (!currentFile) return;
    const blob = new Blob([currentFile.content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = currentFile.path.split("/").pop() ?? "file.txt";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const startEdit = () => {
    if (!currentFile) return;
    setEditContent(currentFile.content);
    setEditMode(true);
  };

  const saveEdit = () => {
    if (!currentFile) return;
    updateFileContent(currentFile.path, editContent);
    setEditMode(false);
  };

  const cancelEdit = () => {
    setEditMode(false);
    setEditContent("");
  };

  const toggleSearch = () => {
    setSearchOpen((o) => {
      if (!o) setTimeout(() => searchRef.current?.focus(), 50);
      else setSearchQuery("");
      return !o;
    });
  };

  const navigateMatch = (dir: 1 | -1) => {
    setSearchMatchIndex((i) => {
      const next = i + dir;
      if (next < 0) return searchMatchCount - 1;
      if (next >= searchMatchCount) return 0;
      return next;
    });
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "f" && codeEditorOpen) {
        e.preventDefault();
        toggleSearch();
      }
      if (e.key === "Escape" && searchOpen) {
        setSearchOpen(false);
        setSearchQuery("");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [codeEditorOpen, searchOpen]);

  const lineCount = (editMode ? editContent : currentFile?.content ?? "").split("\n").length;

  return (
    <div
      className={cn(
        "flex flex-col border-t border-border bg-card transition-all duration-300 overflow-hidden shrink-0",
        codeEditorOpen ? "" : "h-9"
      )}
      style={codeEditorOpen ? { height: panelHeight } : undefined}
    >
      {/* Drag-to-resize handle — only visible when open */}
      {codeEditorOpen && (
        <div
          onMouseDown={handleDragStart}
          className="h-1.5 w-full cursor-row-resize flex items-center justify-center group shrink-0 bg-border/20 hover:bg-primary/20 transition-colors"
          title="Drag to resize"
        >
          <div className="w-8 h-0.5 rounded bg-border group-hover:bg-primary/60 transition-colors" />
        </div>
      )}

      {/* Toggle bar */}
      <button
        onClick={toggleCodeEditor}
        className="flex items-center gap-2 px-3 h-9 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors shrink-0 w-full text-left"
      >
        <FileCode className="h-3.5 w-3.5" />
        <span>Code Editor</span>
        {files.length > 0 && (
          <span className="bg-primary/10 text-primary px-1.5 py-0.5 rounded text-[10px] font-medium">
            {files.length} file{files.length !== 1 ? "s" : ""}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground/60">
          Ctrl+J
          {codeEditorOpen ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronUp className="h-3.5 w-3.5" />
          )}
        </span>
      </button>

      {codeEditorOpen && (
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* File tree */}
          <div className="w-48 shrink-0 border-r border-border overflow-y-auto scrollbar-thin bg-muted/20">
            {files.length === 0 ? (
              <p className="text-xs text-muted-foreground p-3">No files yet</p>
            ) : (
              <div className="py-1">
                {files.map((f) => {
                  const parts = f.path.split("/");
                  const indent = parts.length - 1;
                  const name = parts[parts.length - 1];
                  return (
                    <button
                      key={f.path}
                      onClick={() => {
                        setActiveFile(f.path);
                        if (editMode) cancelEdit();
                        setSearchQuery("");
                      }}
                      className={cn(
                        "w-full text-left py-1 pr-3 text-xs truncate hover:bg-accent transition-colors flex items-center gap-1",
                        activeFile === f.path
                          ? "bg-accent text-accent-foreground font-medium"
                          : "text-muted-foreground"
                      )}
                      style={{ paddingLeft: `${12 + indent * 10}px` }}
                      title={f.path}
                    >
                      <span className="shrink-0 opacity-50">
                        {name.includes(".") ? "📄" : "📁"}
                      </span>
                      <span className="truncate">{name}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Code view */}
          <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
            {currentFile ? (
              <>
                {/* Tab bar */}
                <div className="flex items-center gap-1 px-3 h-8 border-b border-border bg-background shrink-0">
                  <span className="text-xs text-muted-foreground font-mono truncate flex-1">
                    {currentFile.path}
                  </span>

                  {/* Search toggle */}
                  <Button
                    variant="ghost"
                    size="sm"
                    className={cn("h-6 text-xs gap-1 shrink-0", searchOpen && "text-primary")}
                    onClick={toggleSearch}
                    title="Search in file (Ctrl+F)"
                  >
                    <Search className="h-3 w-3" />
                  </Button>

                  {/* Edit / Save / Cancel */}
                  {editMode ? (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 text-xs gap-1 shrink-0 text-green-500 hover:text-green-400"
                        onClick={saveEdit}
                      >
                        <Save className="h-3 w-3" /> Save
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 text-xs gap-1 shrink-0"
                        onClick={cancelEdit}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 text-xs gap-1 shrink-0"
                      onClick={startEdit}
                      title="Edit file"
                    >
                      <Pencil className="h-3 w-3" />
                    </Button>
                  )}

                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-xs gap-1 shrink-0"
                    onClick={handleCopy}
                  >
                    {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
                    {copied ? "Copied!" : "Copy"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-xs gap-1 shrink-0"
                    onClick={handleDownloadFile}
                    title="Download file"
                  >
                    <Download className="h-3 w-3" />
                  </Button>
                </div>

                {/* Search bar */}
                {searchOpen && (
                  <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-background/60 shrink-0">
                    <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <input
                      ref={searchRef}
                      value={searchQuery}
                      onChange={(e) => { setSearchQuery(e.target.value); setSearchMatchIndex(0); }}
                      placeholder="Find in file…"
                      className="flex-1 text-xs bg-transparent outline-none text-foreground placeholder:text-muted-foreground/60"
                    />
                    <span className="text-[10px] text-muted-foreground shrink-0">
                      {searchMatchCount > 0
                        ? `${searchMatchIndex + 1}/${searchMatchCount}`
                        : searchQuery ? "0 matches" : ""}
                    </span>
                    <button
                      onClick={() => navigateMatch(-1)}
                      disabled={searchMatchCount === 0}
                      className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                    >
                      <ChevronLeft className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => navigateMatch(1)}
                      disabled={searchMatchCount === 0}
                      className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                    >
                      <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => { setSearchOpen(false); setSearchQuery(""); }}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}

                {/* Code content */}
                <div className="flex flex-1 overflow-auto scrollbar-thin" ref={codeRef}>
                  {/* Line numbers — one text node, not one div per line: a 5k-line
                      file previously created 5k DOM nodes just for the gutter. (L3) */}
                  <div className="select-none text-right pr-3 pl-3 py-3 text-[11px] font-mono text-muted-foreground/40 bg-muted/10 border-r border-border shrink-0 leading-5 whitespace-pre">
                    {Array.from({ length: lineCount }, (_, i) => i + 1).join("\n")}
                  </div>

                  {editMode ? (
                    <textarea
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      className="flex-1 py-3 px-3 text-[11px] font-mono text-foreground bg-transparent resize-none outline-none leading-5 scrollbar-thin"
                      spellCheck={false}
                      autoComplete="off"
                      autoCorrect="off"
                    />
                  ) : (
                    <pre className="flex-1 py-3 px-3 text-[11px] font-mono whitespace-pre leading-5 overflow-x-auto">
                      {searchQuery && searchMatchCount > 0 ? (
                        <code
                          dangerouslySetInnerHTML={{ __html: highlightedWithSearch() }}
                        />
                      ) : highlightedHtml ? (
                        <code dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
                      ) : (
                        <code className="text-foreground">{currentFile.content}</code>
                      )}
                    </pre>
                  )}
                </div>
              </>
            ) : (
              <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
                Select a file to view
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
