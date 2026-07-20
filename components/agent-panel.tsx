"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useProjectStore } from "@/stores/project-store";
import { useUIStore } from "@/stores/ui-store";
import { Button } from "@/components/ui/button";
import {
  Send, Square, ChevronDown, CheckCircle2, XCircle,
  Loader, Bot, RefreshCw, AlertTriangle, Activity,
  Zap, FileCode, Paperclip, ImageIcon, X, Play,
  FileText, PlugZap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { estimateCost, formatCost } from "@/lib/token-estimate";
import { MODEL_OPTIONS } from "@/stores/ui-store";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// ─── Types ────────────────────────────────────────────────────────────────────

type AgentEvent =
  | { type: "turn_start";   turn: number }
  | { type: "text";         content: string }
  | { type: "tool_call";    id: string; tool: string; input: Record<string, unknown> }
  | { type: "tool_result";  id: string; tool: string; output: string; success: boolean }
  | { type: "done";         summary: string; turns: number; inputTokens: number; outputTokens: number; cacheReadTokens?: number; mode?: "subscription" | "api-key" | "gemini"; rateLimits?: Record<string, string> }
  | { type: "error";        message: string };

interface ToolCallState {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  output?: string;
  success?: boolean;
  pending: boolean;
  expanded: boolean;
}

type DisplayItem =
  | { kind: "user_prompt";  content: string; id: string }
  | { kind: "turn_header";  turn: number; id: string }
  | { kind: "tool_call";    state: ToolCallState; id: string }
  | { kind: "agent_text";   content: string; id: string }
  | { kind: "plan";         content: string; id: string; status: "pending" | "approved" | "rejected" }
  | { kind: "agent_done";   summary: string; turns: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; id: string }
  | { kind: "agent_error";  message: string; id: string };

type PendingImage = {
  name: string; data: string;
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  preview: string;
};

// ─── Tool display helpers ─────────────────────────────────────────────────────

const TOOL_META: Record<string, { label: string; icon: string }> = {
  get_project_manifest: { label: "Scanning project",  icon: "📁" },
  read_file:            { label: "Reading",            icon: "📄" },
  write_file:           { label: "Writing",            icon: "✏️" },
  delete_file:          { label: "Deleting",           icon: "🗑️" },
  list_directory:       { label: "Listing",            icon: "📂" },
  search_files:         { label: "Searching",          icon: "🔍" },
  run_command:          { label: "Running",            icon: "⚡" },
};

const FRAMEWORK_PORTS: Record<string, number> = {
  nextjs: 3000, "react-vite": 5173, vuejs: 5173,
  svelte: 5173, "node-express": 3001, "python-flask": 5000,
};

function toolSummary(tool: string, input: Record<string, unknown>): string {
  const label = TOOL_META[tool]?.label ?? tool;
  if (input.path)    return `${label} ${input.path}`;
  if (input.command) return `${label}: ${input.command}`;
  if (input.query)   return `${label}: "${input.query}"`;
  return label;
}

// ─── Tool call card ───────────────────────────────────────────────────────────

function ToolCallCard({ state, onToggle }: { state: ToolCallState; onToggle: () => void }) {
  const summary = toolSummary(state.tool, state.input);
  const icon = TOOL_META[state.tool]?.icon ?? "🔧";

  return (
    <div className={cn(
      "rounded-lg border text-xs overflow-hidden",
      state.pending
        ? "border-border bg-muted/30"
        : state.success
        ? "border-green-500/30 bg-green-500/5"
        : "border-red-500/30 bg-red-500/5"
    )}>
      <button
        onClick={onToggle}
        className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-accent/30 transition-colors"
      >
        <span className="shrink-0 text-base leading-none">{icon}</span>
        <span className={cn(
          "flex-1 font-mono truncate text-[11px]",
          state.pending ? "text-muted-foreground" :
          state.success ? "text-green-400" : "text-red-400"
        )}>
          {summary}
        </span>
        <span className="shrink-0">
          {state.pending
            ? <Loader className="h-3.5 w-3.5 text-muted-foreground animate-spin" />
            : state.success
            ? <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
            : <XCircle className="h-3.5 w-3.5 text-red-500" />}
        </span>
        {!state.pending && (
          <ChevronDown className={cn(
            "h-3.5 w-3.5 text-muted-foreground transition-transform shrink-0",
            state.expanded && "rotate-180"
          )} />
        )}
      </button>
      {state.expanded && state.output && (
        <div className="border-t border-border/50 px-3 py-2 max-h-52 overflow-y-auto scrollbar-thin">
          <pre className="text-[10px] font-mono text-muted-foreground whitespace-pre-wrap leading-relaxed">
            {state.output.length > 4000
              ? state.output.slice(0, 4000) + "\n…(truncated)"
              : state.output}
          </pre>
        </div>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function AgentPanel() {
  const { currentProject, updateFiles, snapshotCurrentFiles, agentTranscripts, addAgentTranscript } = useProjectStore();
  const { selectedModel, setSelectedModel, setAuthMode, setRateLimits } = useUIStore();

  const [input, setInput] = useState("");
  const [items, setItems] = useState<DisplayItem[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [pendingSync, setPendingSync] = useState(false);
  const [planFirstMode, setPlanFirstMode] = useState(false);
  const [agentMode, setAgentMode] = useState<"build" | "discuss">("build");
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  // Running token counters
  const [runTokens, setRunTokens] = useState({ input: 0, output: 0, cacheRead: 0 });
  // Pending prompt waiting for plan approval
  const pendingPromptRef = useRef<{ prompt: string; images: PendingImage[] } | null>(null);
  const pendingPlanIdRef = useRef<string | null>(null);

  const abortRef      = useRef<AbortController | null>(null);
  const bottomRef     = useRef<HTMLDivElement>(null);
  const textareaRef   = useRef<HTMLTextAreaElement>(null);
  const fileInputRef  = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const idCounter     = useRef(0);

  const nextId = () => String(++idCounter.current);
  const currentModelInfo = MODEL_OPTIONS.find((m) => m.id === selectedModel) ?? MODEL_OPTIONS[2];
  const hasFolder = Boolean(currentProject?.folderPath);
  const framework = currentProject?.framework ?? "html-css-js";
  const devPort = FRAMEWORK_PORTS[framework] ?? 3000;

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [items]);
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 144) + "px";
  }, [input]);

  // ── Sync from disk ──────────────────────────────────────────────────────────
  const syncFromDisk = useCallback(async () => {
    if (!currentProject?.folderPath) return;
    setIsSyncing(true);
    try {
      const res = await fetch(
        `/api/projects/files?folderPath=${encodeURIComponent(currentProject.folderPath)}`
      );
      if (!res.ok) throw new Error("Failed to read project folder");
      const { files, truncated } = await res.json() as {
        files: { path: string; content: string }[];
        truncated?: boolean;
      };
      updateFiles(files, "Agent run");
      if (truncated) {
        setItems((prev) => [...prev, {
          kind: "agent_error",
          message: `This project has more than ${files.length} readable files — only the first ${files.length} were loaded into the editor. Files on disk are untouched; the agent still sees everything.`,
          id: nextId(),
        }]);
      }
    } catch (err) {
      console.error("Sync failed:", err);
    } finally {
      setIsSyncing(false);
      setPendingSync(false);
    }
  }, [currentProject, updateFiles]);

  // ── Mutate tool call by event id ────────────────────────────────────────────
  const updateToolCall = useCallback((id: string, updates: Partial<ToolCallState>) => {
    setItems((prev) =>
      prev.map((item) =>
        item.kind === "tool_call" && item.state.id === id
          ? { ...item, state: { ...item.state, ...updates } }
          : item
      )
    );
  }, []);

  const toggleToolExpand = useCallback((id: string) => {
    setItems((prev) =>
      prev.map((item) =>
        item.kind === "tool_call" && item.state.id === id
          ? { ...item, state: { ...item.state, expanded: !item.state.expanded } }
          : item
      )
    );
  }, []);

  // ── Core stream reader ──────────────────────────────────────────────────────
  async function streamAgent(
    opts: {
      prompt: string;
      images?: PendingImage[];
      planOnly?: boolean;
      discussOverride?: boolean;
      onDone?: () => void;
    }
  ) {
    const { prompt, images = [], planOnly = false, discussOverride, onDone } = opts;
    const isDiscuss = discussOverride !== undefined ? discussOverride : agentMode === "discuss";

    // Give the run cross-run memory: send the last few (prompt → summary) pairs
    // from prior agent runs on this project as history. (F11)
    const priorRuns = currentProject ? agentTranscripts[currentProject.id] ?? [] : [];
    const history = priorRuns.slice(-3).flatMap((r) => [
      { role: "user" as const, content: r.prompt },
      { role: "assistant" as const, content: r.summary },
    ]);

    const res = await fetch("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: abortRef.current?.signal,
      body: JSON.stringify({
        prompt,
        projectPath: currentProject!.folderPath,
        framework: currentProject!.framework,
        model: selectedModel,
        history,
        planOnly,
        discussMode: isDiscuss,
        images: images.map((img) => ({ data: img.data, mediaType: img.mediaType })),
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "Agent request failed" })) as { error?: string };
      setItems((prev) => [...prev, {
        kind: "agent_error",
        message: err.error ?? "Agent request failed",
        id: nextId(),
      }]);
      return;
    }

    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          let event: AgentEvent;
          try { event = JSON.parse(line) as AgentEvent; } catch { continue; }

          switch (event.type) {
            case "turn_start":
              setItems((prev) => [...prev, { kind: "turn_header", turn: event.turn, id: nextId() }]);
              break;

            case "text": {
              if (planOnly) {
                // Accumulate plan text into a single plan item
                const planId = pendingPlanIdRef.current ?? (() => {
                  const id = nextId();
                  pendingPlanIdRef.current = id;
                  setItems((prev) => [...prev, {
                    kind: "plan", content: "", id, status: "pending",
                  }]);
                  return id;
                })();
                setItems((prev) =>
                  prev.map((item) =>
                    item.kind === "plan" && item.id === planId
                      ? { ...item, content: item.content + event.content }
                      : item
                  )
                );
              } else {
                setItems((prev) => [...prev, { kind: "agent_text", content: event.content, id: nextId() }]);
              }
              break;
            }

            case "tool_call":
              setItems((prev) => [...prev, {
                kind: "tool_call",
                id: nextId(),
                state: { id: event.id, tool: event.tool, input: event.input, pending: true, expanded: false },
              }]);
              break;

            case "tool_result":
              updateToolCall(event.id, { output: event.output, success: event.success, pending: false });
              break;

            case "done":
              setRunTokens((t) => ({
                input: t.input + event.inputTokens,
                output: t.output + event.outputTokens,
                cacheRead: t.cacheRead + (event.cacheReadTokens ?? 0),
              }));
              if (event.mode) setAuthMode(event.mode);
              if (event.rateLimits && Object.keys(event.rateLimits).length > 0) {
                setRateLimits({ mode: event.mode ?? "unknown", limits: event.rateLimits, capturedAt: Date.now() });
              }
              if (!planOnly) {
                setItems((prev) => [...prev, {
                  kind: "agent_done",
                  summary: event.summary,
                  turns: event.turns,
                  inputTokens: event.inputTokens,
                  outputTokens: event.outputTokens,
                  cacheReadTokens: event.cacheReadTokens ?? 0,
                  id: nextId(),
                }]);
                // Folder-backed projects: the agent wrote directly to disk, so
                // pull those changes back into the store automatically instead
                // of relying on the user clicking the manual Sync banner. Only
                // discuss mode (read-only) skips this — nothing changed on disk.
                if (!isDiscuss) {
                  void syncFromDisk();
                  // Remember this run so the next one has context. (F11)
                  if (currentProject && event.summary) {
                    addAgentTranscript(currentProject.id, {
                      prompt,
                      summary: event.summary,
                      createdAt: new Date().toISOString(),
                    });
                  }
                }
                // Discuss mode is read-only — nothing changed on disk, so no
                // sync (the old `else setPendingSync(true)` showed a false
                // "Agent wrote files to disk" banner after read-only runs).
              }
              onDone?.();
              break;

            case "error":
              setItems((prev) => [...prev, { kind: "agent_error", message: event.message, id: nextId() }]);
              break;
          }
        }
      }
    }
  }

  // ── Execute: the real agent run after plan approval ─────────────────────────
  const executeApprovedPlan = async (prompt: string, images: PendingImage[]) => {
    // Capture the id of the plan being approved BEFORE clearing the ref, so we
    // include *this* plan's text as context — not the first plan in the feed
    // from an earlier cycle. (F14)
    const approvedId = pendingPlanIdRef.current;
    if (approvedId) {
      setItems((prev) =>
        prev.map((item) =>
          item.kind === "plan" && item.id === approvedId ? { ...item, status: "approved" } : item
        )
      );
      pendingPlanIdRef.current = null;
    }

    setIsRunning(true);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // Re-read the approved plan from items to include as context
      const planItem = items.find(
        (i) => i.kind === "plan" && i.id === approvedId
      ) as { kind: "plan"; content: string } | undefined;
      const planContext = planItem
        ? `\nApproved plan:\n${planItem.content}\n\nNow execute this plan exactly as described.`
        : "";

      await streamAgent({ prompt: prompt + planContext, images });
    } catch (err: unknown) {
      if (!(err instanceof Error && err.name === "AbortError")) {
        setItems((prev) => [...prev, {
          kind: "agent_error",
          message: err instanceof Error ? err.message : "Unknown error",
          id: nextId(),
        }]);
      }
    } finally {
      abortRef.current = null;
      setIsRunning(false);
    }
  };

  // ── Main send handler ───────────────────────────────────────────────────────
  const handleRun = async () => {
    if (!input.trim() || isRunning || !currentProject || !hasFolder) return;

    const prompt = input.trim();
    const images = [...pendingImages];
    setInput("");
    setPendingImages([]);
    setRunTokens({ input: 0, output: 0, cacheRead: 0 });
    setPendingSync(false);
    pendingPlanIdRef.current = null;

    // Auto-snapshot before every agent run
    snapshotCurrentFiles("Before agent: " + prompt.slice(0, 50));

    setItems((prev) => [...prev, { kind: "user_prompt", content: prompt, id: nextId() }]);

    if (planFirstMode) {
      // Phase 1: generate plan only, wait for approval
      pendingPromptRef.current = { prompt, images };
      setIsRunning(true);
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        await streamAgent({
          prompt,
          images,
          planOnly: true,
          onDone: () => { /* plan done — waiting for user approval */ },
        });
      } catch (err: unknown) {
        if (!(err instanceof Error && err.name === "AbortError")) {
          setItems((prev) => [...prev, {
            kind: "agent_error",
            message: err instanceof Error ? err.message : "Unknown error",
            id: nextId(),
          }]);
        }
      } finally {
        abortRef.current = null;
        setIsRunning(false);
      }
    } else {
      // Direct execution (no plan step)
      setIsRunning(true);
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        await streamAgent({ prompt, images });
      } catch (err: unknown) {
        if (!(err instanceof Error && err.name === "AbortError")) {
          setItems((prev) => [...prev, {
            kind: "agent_error",
            message: err instanceof Error ? err.message : "Unknown error",
            id: nextId(),
          }]);
        }
      } finally {
        abortRef.current = null;
        setIsRunning(false);
      }
    }
  };

  const handleCancel = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    pendingPromptRef.current = null;
    setIsRunning(false);
  };

  const handleGenerateArchitecture = async () => {
    if (isRunning || !hasFolder) return;
    const prompt =
      "Scan the entire project using get_project_manifest and read the key source files. " +
      "Then create a comprehensive ARCHITECTURE.md file at the project root that covers:\n" +
      "- Tech stack and major dependencies\n" +
      "- Purpose of each main folder and key files\n" +
      "- Design patterns and conventions used in this codebase\n" +
      "- How to add new features or pages\n" +
      "- Any important architectural decisions or constraints\n\n" +
      "Make it genuinely useful for an AI assistant reading it at the start of a new session.";

    snapshotCurrentFiles("Before ARCHITECTURE.md generation");
    setItems((prev) => [...prev, { kind: "user_prompt", content: "Generate ARCHITECTURE.md", id: nextId() }]);
    setRunTokens({ input: 0, output: 0, cacheRead: 0 });
    setPendingSync(false);

    setIsRunning(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamAgent({ prompt, discussOverride: false });
    } catch (err: unknown) {
      if (!(err instanceof Error && err.name === "AbortError")) {
        setItems((prev) => [...prev, {
          kind: "agent_error",
          message: err instanceof Error ? err.message : "Unknown error",
          id: nextId(),
        }]);
      }
    } finally {
      abortRef.current = null;
      setIsRunning(false);
    }
  };

  const handleClear = () => {
    if (isRunning) return;
    setItems([]);
    setPendingSync(false);
    setRunTokens({ input: 0, output: 0, cacheRead: 0 });
    pendingPlanIdRef.current = null;
    pendingPromptRef.current = null;
  };

  // ── File/image attachment ───────────────────────────────────────────────────
  const handleFileAttach = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const content = ev.target?.result as string;
      setInput((prev) =>
        prev
          ? `${prev}\n\n[File: ${file.name}]\n\`\`\`\n${content}\n\`\`\``
          : `[File: ${file.name}]\n\`\`\`\n${content}\n\`\`\``
      );
      setTimeout(() => textareaRef.current?.focus(), 0);
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const handleImageAttach = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const validTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    const mediaType = validTypes.includes(file.type)
      ? (file.type as PendingImage["mediaType"])
      : "image/png";
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target?.result as string;
      const base64 = dataUrl.split(",")[1];
      setPendingImages((prev) => [...prev, { name: file.name, data: base64, mediaType, preview: dataUrl }]);
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  // ── Markdown renderer (shared) ──────────────────────────────────────────────
  function MdContent({ text }: { text: string }) {
    return (
      <div className="prose prose-sm dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            code({ className, children, ...props }) {
              if (className?.includes("language-")) {
                return (
                  <pre className="bg-background/60 border border-border rounded p-2 overflow-x-auto my-1.5">
                    <code className="text-[10px] font-mono" {...props}>{children}</code>
                  </pre>
                );
              }
              return <code className="bg-background/60 rounded px-1 text-[11px] font-mono text-primary" {...props}>{children}</code>;
            },
            p: ({ children }) => <p className="text-foreground mb-1.5 last:mb-0 text-sm">{children}</p>,
            ul: ({ children }) => <ul className="list-disc pl-4 mb-1.5 space-y-0.5">{children}</ul>,
            ol: ({ children }) => <ol className="list-decimal pl-4 mb-1.5 space-y-0.5">{children}</ol>,
            li: ({ children }) => <li className="text-foreground text-sm">{children}</li>,
          }}
        >
          {text}
        </ReactMarkdown>
      </div>
    );
  }

  // ─── Render ─────────────────────────────────────────────────────────────────
  const runningCost = estimateCost(runTokens.input, runTokens.output, selectedModel, runTokens.cacheRead);

  return (
    <div className="flex flex-col h-full bg-card">
      {/* Hidden file inputs */}
      <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileAttach}
        accept=".txt,.json,.ts,.tsx,.js,.jsx,.css,.html,.md,.py,.go,.rs,.java,.c,.cpp,.h,.sh,.env,.yaml,.yml,.toml,.xml,.svg,.csv" />
      <input ref={imageInputRef} type="file" className="hidden" accept="image/jpeg,image/png,image/gif,image/webp" onChange={handleImageAttach} />

      {/* Event feed */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2 scrollbar-thin">

        {/* Empty state */}
        {items.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center gap-3 py-6">
            <div className="w-12 h-12 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center">
              <Bot className="h-5 w-5 text-primary" />
            </div>
            <div>
              <p className="text-sm font-semibold">Agent Mode</p>
              <p className="text-xs text-muted-foreground mt-1 max-w-[240px]">
                Reads and writes your files directly. Runs builds, fixes errors, iterates — all autonomously.
              </p>
            </div>
            {!hasFolder ? (
              <div className="flex items-start gap-2 bg-yellow-500/10 border border-yellow-500/30 rounded-lg px-3 py-2 text-left max-w-xs">
                <AlertTriangle className="h-4 w-4 text-yellow-400 shrink-0 mt-0.5" />
                <p className="text-xs text-yellow-300">
                  Agent needs a project folder. Switch to Generate mode, build something, then come back.
                </p>
              </div>
            ) : (
              <div className="space-y-2 w-full max-w-xs">
                {/* Preview hint */}
                <div className="flex items-start gap-2 bg-muted/40 border border-border/60 rounded-lg px-3 py-2 text-left">
                  <PlugZap className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                  <p className="text-xs text-muted-foreground">
                    After the agent builds your app, run{" "}
                    <code className="text-primary font-mono text-[10px]">
                      {framework === "python-flask" ? "python app.py" : "npm run dev"}
                    </code>{" "}
                    in your terminal, then connect the preview to{" "}
                    <code className="text-primary font-mono text-[10px]">localhost:{devPort}</code>.
                  </p>
                </div>
                {/* ARCHITECTURE.md one-click */}
                <button
                  onClick={handleGenerateArchitecture}
                  disabled={isRunning}
                  className="flex items-center gap-2 bg-muted/40 border border-border/60 rounded-lg px-3 py-2 text-left hover:border-primary/40 hover:bg-primary/5 transition-colors w-full group disabled:opacity-50"
                >
                  <FileText className="h-4 w-4 text-primary/70 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-foreground group-hover:text-primary transition-colors">Generate ARCHITECTURE.md</p>
                    <p className="text-[10px] text-muted-foreground">Agent scans your project and writes a context doc — read automatically every session.</p>
                  </div>
                  <Play className="h-3.5 w-3.5 text-muted-foreground group-hover:text-primary transition-colors shrink-0" />
                </button>
              </div>
            )}
          </div>
        )}

        {/* Display items */}
        {items.map((item) => {
          switch (item.kind) {
            case "user_prompt":
              return (
                <div key={item.id} className="flex justify-end">
                  <div className="max-w-[85%] rounded-2xl rounded-tr-sm px-4 py-2.5 bg-primary/10 border border-primary/20 text-sm text-foreground leading-relaxed whitespace-pre-wrap">
                    {item.content}
                  </div>
                </div>
              );

            case "turn_header":
              return (
                <div key={item.id} className="flex items-center gap-2 py-0.5">
                  <Activity className="h-3 w-3 text-primary/50 shrink-0" />
                  <span className="text-[9px] font-bold uppercase tracking-widest text-primary/50">
                    Turn {item.turn}
                  </span>
                  <div className="flex-1 h-px bg-border/30" />
                </div>
              );

            case "tool_call":
              return (
                <ToolCallCard
                  key={item.id}
                  state={item.state}
                  onToggle={() => toggleToolExpand(item.state.id)}
                />
              );

            case "agent_text":
              return (
                <div key={item.id} className="rounded-xl bg-muted/40 border border-border px-3 py-2.5">
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <Bot className="h-3 w-3 text-primary" />
                    <span className="text-[9px] font-bold uppercase tracking-widest text-primary">Agent</span>
                  </div>
                  <MdContent text={item.content} />
                </div>
              );

            case "plan":
              return (
                <div key={item.id} className={cn(
                  "rounded-xl border px-3 py-2.5 space-y-2",
                  item.status === "approved"  ? "border-green-500/30 bg-green-500/5" :
                  item.status === "rejected"  ? "border-red-500/30 bg-red-500/10 opacity-60" :
                  "border-primary/30 bg-primary/5"
                )}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <FileText className="h-3.5 w-3.5 text-primary" />
                      <span className="text-[10px] font-bold uppercase tracking-widest text-primary">
                        {item.status === "approved" ? "Plan approved" :
                         item.status === "rejected" ? "Plan cancelled" :
                         "Proposed plan — review before executing"}
                      </span>
                    </div>
                  </div>
                  <MdContent text={item.content} />
                  {item.status === "pending" && pendingPromptRef.current && (
                    <div className="flex gap-2 pt-1">
                      <Button
                        size="sm"
                        className="gap-1.5 h-7 text-xs bg-primary"
                        onClick={() => {
                          const pending = pendingPromptRef.current!;
                          pendingPromptRef.current = null;
                          executeApprovedPlan(pending.prompt, pending.images);
                        }}
                      >
                        <Play className="h-3 w-3" /> Execute plan
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs text-muted-foreground"
                        onClick={() => {
                          pendingPromptRef.current = null;
                          pendingPlanIdRef.current = null;
                          setItems((prev) =>
                            prev.map((i) =>
                              i.kind === "plan" && i.id === item.id
                                ? { ...i, status: "rejected" }
                                : i
                            )
                          );
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  )}
                </div>
              );

            case "agent_done": {
              const cost = estimateCost(item.inputTokens, item.outputTokens, selectedModel, item.cacheReadTokens);
              return (
                <div key={item.id} className="rounded-xl bg-green-500/10 border border-green-500/30 px-3 py-2.5 space-y-1.5">
                  <div className="flex items-center gap-1.5">
                    <CheckCircle2 className="h-4 w-4 text-green-500" />
                    <span className="text-xs font-semibold text-green-400">Agent complete</span>
                  </div>
                  {item.summary && <p className="text-xs text-foreground/80 leading-relaxed">{item.summary}</p>}
                  <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                    <span>{item.turns} turn{item.turns !== 1 ? "s" : ""}</span>
                    <span>{item.inputTokens.toLocaleString()} in · {item.outputTokens.toLocaleString()} out</span>
                    <span className="text-primary font-mono">{formatCost(cost)}</span>
                  </div>
                </div>
              );
            }

            case "agent_error":
              return (
                <div key={item.id} className="rounded-xl bg-red-500/10 border border-red-500/30 px-3 py-2 flex items-start gap-2">
                  <XCircle className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
                  <p className="text-xs text-red-300">{item.message}</p>
                </div>
              );

            default:
              return null;
          }
        })}

        {/* Sync project banner */}
        {pendingSync && (
          <div className="rounded-xl bg-primary/10 border border-primary/30 px-3 py-2.5 flex items-center gap-2">
            <FileCode className="h-4 w-4 text-primary shrink-0" />
            <p className="text-xs text-foreground flex-1">Agent wrote files to disk. Sync to update the code editor.</p>
            <Button size="sm" className="h-7 text-xs gap-1.5 shrink-0" onClick={syncFromDisk} disabled={isSyncing}>
              {isSyncing
                ? <><Loader className="h-3 w-3 animate-spin" /> Syncing…</>
                : <><RefreshCw className="h-3 w-3" /> Sync</>}
            </Button>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input area */}
      <div className="border-t border-border bg-card shrink-0">
        {/* Build / Discuss mode toggle */}
        <div className="flex items-center gap-2 px-3 pt-2 pb-0">
          <div className="flex bg-muted rounded-lg p-0.5 gap-0.5">
            <button
              onClick={() => setAgentMode("build")}
              className={cn(
                "px-3 py-1 text-xs rounded-md font-semibold transition-colors",
                agentMode === "build"
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              Build
            </button>
            <button
              onClick={() => setAgentMode("discuss")}
              className={cn(
                "px-3 py-1 text-xs rounded-md font-semibold transition-colors",
                agentMode === "discuss"
                  ? "bg-blue-500 text-white shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              Discuss
            </button>
          </div>
          {agentMode === "discuss" && (
            <span className="text-[10px] text-blue-400">Read-only · no file writes</span>
          )}
        </div>

        {/* Options bar */}
        <div className="flex items-center justify-between px-3 pt-1.5 pb-1">
          {/* Model picker */}
          <div className="relative">
            <button
              onClick={() => setShowModelPicker(!showModelPicker)}
              className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-primary transition-colors"
            >
              <Zap className="h-3 w-3 text-primary" />
              <span className="font-medium text-primary">{currentModelInfo.label}</span>
              <span className="bg-primary/10 text-primary text-[9px] font-bold px-1.5 py-0.5 rounded uppercase">
                {currentModelInfo.badge}
              </span>
              <ChevronDown className={cn("h-3 w-3 transition-transform", showModelPicker && "rotate-180")} />
            </button>
            {showModelPicker && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowModelPicker(false)} />
                <div className="absolute bottom-full left-0 mb-1 w-72 bg-popover border border-border rounded-xl shadow-2xl z-50 overflow-hidden">
                  <div className="px-3 py-2 border-b border-border">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Select Model</p>
                  </div>
                  {MODEL_OPTIONS.map((m) => (
                    <button key={m.id}
                      onClick={() => { setSelectedModel(m.id); setShowModelPicker(false); }}
                      className={cn("w-full flex items-center justify-between px-3 py-2.5 text-left hover:bg-accent/50 transition-colors", selectedModel === m.id && "bg-primary/10")}
                    >
                      <div>
                        <p className={cn("text-sm font-medium", selectedModel === m.id ? "text-primary" : "text-foreground")}>{m.label}</p>
                        <p className="text-[11px] text-muted-foreground">{m.description}</p>
                      </div>
                      <span className={cn("text-[9px] font-bold px-1.5 py-0.5 rounded uppercase shrink-0 ml-2",
                        selectedModel === m.id ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>
                        {m.badge}
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Plan-first toggle */}
          <button
            onClick={() => setPlanFirstMode(!planFirstMode)}
            title={planFirstMode ? "Plan-first ON — agent will show a plan before executing" : "Click to enable plan-first mode"}
            className={cn(
              "flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-md border transition-colors",
              planFirstMode
                ? "bg-primary/10 border-primary/40 text-primary"
                : "border-border text-muted-foreground hover:text-primary hover:border-primary/30"
            )}
          >
            <FileText className="h-3 w-3" />
            {planFirstMode ? "Plan-first ON" : "Plan-first"}
          </button>
        </div>

        {/* Running cost */}
        {isRunning && (runTokens.input > 0 || runTokens.output > 0) && (
          <div className="px-3 pb-1 flex items-center gap-2 text-[10px] text-muted-foreground">
            <Loader className="h-3 w-3 animate-spin text-primary" />
            <span>Running · {runTokens.input.toLocaleString()} in · {runTokens.output.toLocaleString()} out · {formatCost(runningCost)}</span>
          </div>
        )}

        {/* Pending image thumbnails */}
        {pendingImages.length > 0 && (
          <div className="flex gap-2 px-3 pb-1 flex-wrap">
            {pendingImages.map((img) => (
              <div key={img.name} className="relative group">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={img.preview} alt={img.name} className="h-10 w-10 object-cover rounded border border-border" />
                <button
                  onClick={() => setPendingImages((p) => p.filter((i) => i.name !== img.name))}
                  className="absolute -top-1 -right-1 w-4 h-4 bg-destructive rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X className="h-2.5 w-2.5 text-white" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Textarea */}
        <div className="px-3 pb-2 space-y-1.5">
          <div className="flex gap-2 items-end">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                  e.preventDefault();
                  handleRun();
                }
              }}
              placeholder={
                !hasFolder
                  ? "Generate a project first to enable agent mode…"
                  : agentMode === "discuss"
                  ? "Ask anything about your project — agent reads files but won't change them…"
                  : planFirstMode
                  ? "Describe what to build — agent will show a plan first…"
                  : "Tell the agent what to build or fix…"
              }
              rows={2}
              style={{ maxHeight: 144 }}
              className="flex-1 resize-none bg-muted/50 border border-border rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground/60 scrollbar-thin"
              disabled={isRunning || !currentProject || !hasFolder}
            />
            {isRunning ? (
              <Button size="icon" className="h-10 w-10 shrink-0 bg-destructive text-white hover:bg-destructive/90 rounded-xl" onClick={handleCancel}>
                <Square className="h-4 w-4" />
              </Button>
            ) : (
              <Button size="icon" className="h-10 w-10 shrink-0 bg-primary text-primary-foreground hover:bg-primary/90 rounded-xl cyan-glow"
                onClick={handleRun} disabled={!input.trim() || !currentProject || !hasFolder}>
                <Send className="h-4 w-4" />
              </Button>
            )}
          </div>

          <div className="flex items-center justify-between text-[11px] text-muted-foreground/70">
            <div className="flex items-center gap-1.5">
              <button onClick={() => fileInputRef.current?.click()} title="Attach text file"
                className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors">
                <Paperclip className="h-3.5 w-3.5" />
              </button>
              <button onClick={() => imageInputRef.current?.click()} title="Attach image for Claude vision"
                className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors">
                <ImageIcon className="h-3.5 w-3.5" />
              </button>
              {!isRunning && items.length > 0 && (
                <button onClick={handleClear} className="text-[10px] text-muted-foreground hover:text-foreground transition-colors ml-1">
                  Clear
                </button>
              )}
            </div>
            <span>Ctrl+Enter to run</span>
          </div>
        </div>
      </div>
    </div>
  );
}
