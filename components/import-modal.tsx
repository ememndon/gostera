"use client";

import { useState, useRef, useCallback } from "react";
import { useProjectStore } from "@/stores/project-store";
import { useUIStore } from "@/stores/ui-store";
import { Button } from "@/components/ui/button";
import {
  X, FolderOpen, Upload, FileArchive, AlertCircle,
  ChevronRight, Check, Loader2, FileCode, RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Framework, ProjectFile } from "@/lib/types";
import JSZip from "jszip";

// ─── Filtering ──────────────────────────────────────────────────────────────

const IGNORED_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build", "__pycache__",
  ".venv", "venv", ".turbo", "coverage", "out", ".svelte-kit", ".nuxt",
  "target", "vendor", ".cache", ".expo", "android", "ios", ".yarn",
  ".pnpm", "public/build", ".vercel", ".netlify",
]);

const TEXT_EXTENSIONS = new Set([
  "ts","tsx","js","jsx","mjs","cjs","html","htm","css","scss","sass","less",
  "json","yaml","yml","toml","ini","env","md","mdx","txt","py","rb","php",
  "go","rs","java","kt","c","cpp","h","hpp","sh","bash","zsh","fish","sql",
  "graphql","gql","vue","svelte","xml","svg","lock","conf","prisma","tf",
  "dockerfile","makefile","gitignore","eslintrc","prettierrc","babelrc",
]);

const IGNORED_FILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", ".DS_Store",
  "Thumbs.db", ".env.local", ".env.production",
]);

const MAX_FILE_BYTES = 300_000; // 300 KB per file
// Aligned with /api/projects/files' cap so import and disk sync-back agree
// on how many files a project can hold. (L2)
const MAX_FILES = 300;

function isTextFile(name: string): boolean {
  if (IGNORED_FILES.has(name)) return false;
  const lower = name.toLowerCase();
  // Dotfiles like .env, .gitignore, .eslintrc (no double extension)
  if (lower.startsWith(".") && !lower.slice(1).includes(".")) return true;
  const ext = lower.split(".").pop() ?? "";
  return TEXT_EXTENSIONS.has(ext);
}

function isIgnoredPath(path: string): boolean {
  const parts = path.split("/");
  return parts.some((p) => IGNORED_DIRS.has(p));
}

// ─── Framework detection ─────────────────────────────────────────────────────

function detectFramework(files: ProjectFile[]): Framework {
  const pkgFile = files.find((f) => f.path === "package.json");
  if (pkgFile) {
    try {
      const pkg = JSON.parse(pkgFile.content) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if ("next" in deps) return "nextjs";
      if ("vite" in deps && "react" in deps) return "react-vite";
      if ("@vitejs/plugin-vue" in deps || "vue" in deps) return "vuejs";
      if ("svelte" in deps) return "svelte";
      if ("express" in deps) return "node-express";
    } catch { /* ignore */ }
  }
  if (files.some((f) => f.path === "app.py" || f.path === "requirements.txt")) {
    return "python-flask";
  }
  if (files.some((f) => f.path === "index.html" || f.path.endsWith(".html"))) {
    return "html-css-js";
  }
  return "html-css-js";
}

// ─── File System Access API reader ───────────────────────────────────────────

async function readDirectoryHandle(
  handle: FileSystemDirectoryHandle,
  prefix = "",
  results: ProjectFile[] = []
): Promise<ProjectFile[]> {
  for await (const [name, child] of handle as unknown as AsyncIterable<[string, FileSystemHandle]>) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (child.kind === "directory") {
      if (!IGNORED_DIRS.has(name)) {
        await readDirectoryHandle(child as FileSystemDirectoryHandle, path, results);
      }
    } else if (isTextFile(name) && results.length < MAX_FILES) {
      try {
        const file = await (child as FileSystemFileHandle).getFile();
        if (file.size < MAX_FILE_BYTES) {
          const content = await file.text();
          results.push({ path, content });
        }
      } catch { /* skip unreadable files */ }
    }
  }
  return results;
}

// ─── ZIP reader ───────────────────────────────────────────────────────────────

async function readZipFile(file: File): Promise<{ name: string; files: ProjectFile[] }> {
  const zip = await JSZip.loadAsync(file);
  const files: ProjectFile[] = [];

  // Detect if all files share a common root folder
  const allPaths = Object.keys(zip.files).filter((p) => !zip.files[p].dir);
  let rootPrefix = "";
  if (allPaths.length > 0) {
    const firstParts = allPaths[0].split("/");
    if (firstParts.length > 1) {
      const candidate = firstParts[0] + "/";
      if (allPaths.every((p) => p.startsWith(candidate))) {
        rootPrefix = candidate;
      }
    }
  }

  for (const [zipPath, zipEntry] of Object.entries(zip.files)) {
    if (zipEntry.dir) continue;
    const relativePath = rootPrefix ? zipPath.slice(rootPrefix.length) : zipPath;
    if (!relativePath) continue;
    if (isIgnoredPath(relativePath)) continue;
    const fileName = relativePath.split("/").pop() ?? "";
    if (!isTextFile(fileName)) continue;
    if (files.length >= MAX_FILES) break;

    try {
      const content = await zipEntry.async("string");
      if (content.length < MAX_FILE_BYTES) {
        files.push({ path: relativePath, content });
      }
    } catch { /* skip binary-ish files */ }
  }

  const name = file.name.replace(/\.zip$/i, "").replace(/[_-]/g, " ");
  return { name, files };
}

// ─── Drag & drop FileSystemEntry reader ──────────────────────────────────────

function fileFromEntry(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((res, rej) => entry.file(res, rej));
}

async function readDirEntry(
  entry: FileSystemDirectoryEntry,
  prefix = "",
  results: ProjectFile[] = []
): Promise<ProjectFile[]> {
  await new Promise<void>((resolve, reject) => {
    const reader = entry.createReader();
    function readBatch() {
      reader.readEntries(async (entries) => {
        if (!entries.length) { resolve(); return; }
        for (const child of entries) {
          const path = prefix ? `${prefix}/${child.name}` : child.name;
          if (child.isDirectory && !IGNORED_DIRS.has(child.name)) {
            await readDirEntry(child as FileSystemDirectoryEntry, path, results);
          } else if (child.isFile && isTextFile(child.name) && results.length < MAX_FILES) {
            try {
              const file = await fileFromEntry(child as FileSystemFileEntry);
              if (file.size < MAX_FILE_BYTES) {
                results.push({ path, content: await file.text() });
              }
            } catch { /* skip */ }
          }
        }
        readBatch();
      }, reject);
    }
    readBatch();
  });
  return results;
}

// ─── Framework display name ───────────────────────────────────────────────────

const FRAMEWORK_OPTIONS: { value: Framework; label: string; icon: string }[] = [
  { value: "html-css-js",   label: "HTML / CSS / JS",  icon: "🌐" },
  { value: "react-vite",    label: "React + Vite",      icon: "⚛" },
  { value: "nextjs",        label: "Next.js",           icon: "▲" },
  { value: "vuejs",         label: "Vue.js",            icon: "💚" },
  { value: "svelte",        label: "Svelte",            icon: "🔶" },
  { value: "node-express",  label: "Node / Express",    icon: "🟢" },
  { value: "python-flask",  label: "Python / Flask",    icon: "🐍" },
];

// ─── Component ────────────────────────────────────────────────────────────────

interface ImportState {
  files: ProjectFile[];
  projectName: string;
  framework: Framework;
  skippedCount: number;
}

interface Props {
  onClose: () => void;
}

export function ImportModal({ onClose }: Props) {
  const { createProject, updateFiles } = useProjectStore();
  const { setFramework } = useUIStore();

  const [step, setStep] = useState<"pick" | "preview">("pick");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [imported, setImported] = useState<ImportState | null>(null);

  const zipInputRef = useRef<HTMLInputElement>(null);

  const processFiles = useCallback((files: ProjectFile[], name: string, skippedCount = 0) => {
    if (!files.length) {
      setError("No readable source files were found in the selected location.");
      setLoading(false);
      return;
    }
    const framework = detectFramework(files);
    setImported({ files, projectName: name, framework, skippedCount });
    setError(null);
    setLoading(false);
    setStep("preview");
  }, []);

  // ── Folder picker ──────────────────────────────────────────────────────────
  const handleFolderPick = async () => {
    if (!("showDirectoryPicker" in window)) {
      setError("Your browser doesn't support folder picking. Try Chrome or Edge, or use ZIP import.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const handle = await (window as Window & { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker();
      const files = await readDirectoryHandle(handle);
      const totalInDir = files.length; // approx — we stopped at MAX_FILES
      const skipped = totalInDir >= MAX_FILES ? 1 : 0; // flag rather than exact count
      processFiles(files, handle.name, skipped);
    } catch (e) {
      if ((e as Error)?.name !== "AbortError") {
        setError("Failed to read folder. Make sure you have permission.");
      }
      setLoading(false);
    }
  };

  // ── ZIP import ─────────────────────────────────────────────────────────────
  const handleZipChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLoading(true);
    setError(null);
    try {
      const { name, files } = await readZipFile(file);
      processFiles(files, name);
    } catch {
      setError("Failed to read ZIP file. Make sure it's a valid ZIP.");
      setLoading(false);
    }
    e.target.value = "";
  };

  // ── Drag & drop ────────────────────────────────────────────────────────────
  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    setLoading(true);
    setError(null);

    const items = e.dataTransfer.items;
    if (!items.length) { setLoading(false); return; }

    // Single folder
    const firstEntry = items[0]?.webkitGetAsEntry?.();
    if (firstEntry?.isDirectory) {
      try {
        const files = await readDirEntry(firstEntry as FileSystemDirectoryEntry);
        processFiles(files, firstEntry.name);
      } catch {
        setError("Failed to read dropped folder.");
        setLoading(false);
      }
      return;
    }

    // Single .zip file
    const firstFile = items[0]?.getAsFile?.();
    if (firstFile?.name.endsWith(".zip")) {
      try {
        const { name, files } = await readZipFile(firstFile);
        processFiles(files, name);
      } catch {
        setError("Failed to read ZIP file.");
        setLoading(false);
      }
      return;
    }

    // Multiple individual files
    const textFiles: ProjectFile[] = [];
    for (let i = 0; i < Math.min(items.length, MAX_FILES); i++) {
      const entry = items[i]?.webkitGetAsEntry?.();
      if (entry?.isFile && isTextFile(entry.name)) {
        try {
          const file = await fileFromEntry(entry as FileSystemFileEntry);
          if (file.size < MAX_FILE_BYTES) {
            textFiles.push({ path: entry.name, content: await file.text() });
          }
        } catch { /* skip */ }
      }
    }
    processFiles(textFiles, "Imported Project");
  };

  // ── Final import ───────────────────────────────────────────────────────────
  const handleImport = () => {
    if (!imported) return;
    setFramework(imported.framework);
    const project = createProject(imported.projectName, imported.framework);
    // updateFiles runs immediately after project is in state
    setTimeout(() => updateFiles(imported.files, "Imported from local drive"), 50);
    onClose();
  };

  // ─── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div
        className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-xl mx-4 overflow-hidden flex flex-col"
        style={{ maxHeight: "85vh" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <Upload className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold">Import Project</h2>
          </div>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-thin">
          {/* ── Step: Pick ──────────────────────────────────────────────── */}
          {step === "pick" && (
            <div className="p-4 space-y-3">
              <p className="text-xs text-muted-foreground">
                Import an existing project from your drive. Source files are loaded into Gostera so you can continue building with AI.
              </p>

              {/* Drag & drop zone */}
              <div
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={handleDrop}
                className={cn(
                  "relative border-2 border-dashed rounded-xl p-8 text-center transition-colors",
                  dragging
                    ? "border-primary bg-primary/10"
                    : "border-border bg-muted/20 hover:border-primary/50 hover:bg-muted/30"
                )}
              >
                {loading ? (
                  <div className="flex flex-col items-center gap-2">
                    <Loader2 className="h-8 w-8 text-primary animate-spin" />
                    <p className="text-sm font-medium">Reading files…</p>
                    <p className="text-xs text-muted-foreground">This may take a moment for large projects</p>
                  </div>
                ) : (
                  <>
                    <Upload className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
                    <p className="text-sm font-medium">
                      Drop a project folder or .zip here
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Or choose an import method below
                    </p>
                  </>
                )}
              </div>

              {/* Import method buttons */}
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={handleFolderPick}
                  disabled={loading}
                  className="flex items-center gap-3 p-3 rounded-lg border border-border bg-card hover:border-primary hover:bg-accent transition-all text-left disabled:opacity-50"
                >
                  <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
                    <FolderOpen className="h-4 w-4 text-primary" />
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-foreground">Browse Folder</p>
                    <p className="text-[10px] text-muted-foreground">Pick any project folder</p>
                  </div>
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground ml-auto shrink-0" />
                </button>

                <button
                  onClick={() => zipInputRef.current?.click()}
                  disabled={loading}
                  className="flex items-center gap-3 p-3 rounded-lg border border-border bg-card hover:border-primary hover:bg-accent transition-all text-left disabled:opacity-50"
                >
                  <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
                    <FileArchive className="h-4 w-4 text-primary" />
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-foreground">Import ZIP</p>
                    <p className="text-[10px] text-muted-foreground">Upload a .zip file</p>
                  </div>
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground ml-auto shrink-0" />
                </button>
              </div>

              {/* What gets imported */}
              <div className="bg-muted/30 rounded-lg p-3 border border-border/60 space-y-1.5">
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">What gets imported</p>
                <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1.5"><Check className="h-3 w-3 text-green-500" /> All source code files</span>
                  <span className="flex items-center gap-1.5"><Check className="h-3 w-3 text-green-500" /> Config files</span>
                  <span className="flex items-center gap-1.5"><Check className="h-3 w-3 text-green-500" /> package.json / pyproject</span>
                  <span className="flex items-center gap-1.5"><X className="h-3 w-3 text-red-400" /> node_modules / .git</span>
                  <span className="flex items-center gap-1.5"><X className="h-3 w-3 text-red-400" /> Binary files (images, etc.)</span>
                  <span className="flex items-center gap-1.5"><X className="h-3 w-3 text-red-400" /> Files over 300 KB</span>
                </div>
              </div>

              {error && (
                <div className="flex items-start gap-2 p-2.5 rounded-lg bg-destructive/10 border border-destructive/30">
                  <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                  <p className="text-xs text-destructive">{error}</p>
                </div>
              )}
            </div>
          )}

          {/* ── Step: Preview ────────────────────────────────────────────── */}
          {step === "preview" && imported && (
            <div className="p-4 space-y-4">
              {/* Project name */}
              <div className="space-y-1.5">
                <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                  Project Name
                </label>
                <input
                  value={imported.projectName}
                  onChange={(e) => setImported({ ...imported, projectName: e.target.value })}
                  className="w-full text-sm bg-background border border-border rounded-lg px-3 py-2 outline-none focus:ring-1 focus:ring-primary text-foreground"
                />
              </div>

              {/* Framework */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                    Framework
                  </label>
                  <span className="text-[10px] text-primary">Auto-detected</span>
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  {FRAMEWORK_OPTIONS.map((fw) => (
                    <button
                      key={fw.value}
                      onClick={() => setImported({ ...imported, framework: fw.value })}
                      className={cn(
                        "flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-medium transition-colors text-left",
                        imported.framework === fw.value
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border text-muted-foreground hover:bg-accent/50"
                      )}
                    >
                      <span>{fw.icon}</span>
                      <span className="truncate">{fw.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* File summary */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                    Files to Import
                  </label>
                  <span className="text-[10px] text-muted-foreground">{imported.files.length} files</span>
                </div>

                {imported.skippedCount > 0 && (
                  <div className="flex items-center gap-2 text-[10px] text-yellow-500 bg-yellow-500/10 border border-yellow-500/20 rounded px-2 py-1.5">
                    <AlertCircle className="h-3 w-3 shrink-0" />
                    Capped at {MAX_FILES} files. Some files were skipped — large projects may not fully import.
                  </div>
                )}

                <div className="bg-muted/20 border border-border rounded-lg overflow-hidden">
                  <div className="max-h-52 overflow-y-auto scrollbar-thin divide-y divide-border/30">
                    {imported.files.map((f) => (
                      <div key={f.path} className="flex items-center gap-2 px-3 py-1.5">
                        <FileCode className="h-3 w-3 text-primary/60 shrink-0" />
                        <span className="text-xs font-mono text-muted-foreground truncate flex-1">{f.path}</span>
                        <span className="text-[10px] text-muted-foreground/50 shrink-0">
                          {(f.content.length / 1000).toFixed(1)}k
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-border bg-muted/20 shrink-0 flex items-center gap-2">
          {step === "preview" && (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-muted-foreground"
              onClick={() => { setStep("pick"); setError(null); }}
            >
              <RefreshCw className="h-3.5 w-3.5" /> Pick different
            </Button>
          )}
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
            {step === "preview" && imported && (
              <Button
                size="sm"
                className="gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90"
                onClick={handleImport}
                disabled={!imported.files.length || !imported.projectName.trim()}
              >
                <Upload className="h-3.5 w-3.5" />
                Import {imported.files.length} files
              </Button>
            )}
          </div>
        </div>

        {/* Hidden ZIP input */}
        <input
          ref={zipInputRef}
          type="file"
          className="hidden"
          accept=".zip"
          onChange={handleZipChange}
        />
      </div>
    </div>
  );
}
