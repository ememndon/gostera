"use client";

import Image from "next/image";
import { useRef, useEffect, useState, useCallback, useMemo } from "react";
import { useProjectStore } from "@/stores/project-store";
import { useUIStore, MODEL_OPTIONS } from "@/stores/ui-store";
import { Button } from "@/components/ui/button";
import {
  Send,
  ChevronDown,
  Plus,
  Trash2,
  RefreshCw,
  Zap,
  Paperclip,
  ImageIcon,
  Square,
  X,
  BarChart3,
  PackageCheck,
  Layers,
  Loader2,
  Bot,
} from "lucide-react";
import { AgentPanel } from "@/components/agent-panel";
import { cn } from "@/lib/utils";
import { parseGenerationResponse, salvageGenerationResponse, splitTrailers } from "@/lib/parse-response";
import { AuthBadge } from "@/components/auth-badge";
import { estimateTokens, estimateCost, formatCost, formatTokens } from "@/lib/token-estimate";
import { selectFilesForContext, estimateRequestBudget } from "@/lib/file-selector";
import { fingerprintFileSizes } from "@/lib/project-paths";
import type { Project } from "@/lib/types";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type PendingImage = {
  name: string;
  data: string;
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  preview: string;
};

export function ChatPanel() {
  const {
    chatMessages,
    currentProject,
    promptTemplates,
    addChatMessage,
    updateLastAssistantMessage,
    updateFiles,
    addPromptTemplate,
    removePromptTemplate,
    addGenerationLog,
    mergeFiles,
  } = useProjectStore();
  const {
    mode,
    setMode,
    isGenerating,
    setIsGenerating,
    selectedModel,
    setSelectedModel,
    openTemplates,
    setOpenTemplates,
    setShowUsageModal,
    fullContextMode,
    toggleFullContextMode,
    generationMode,
    setGenerationMode,
    setRateLimits,
  } = useUIStore();

  const [input, setInput] = useState("");
  // Debounced copy of `input` — the context-budget meter recomputes off this
  // (not every keystroke), so typing stays smooth on large projects. (F12)
  const [debouncedInput, setDebouncedInput] = useState("");
  const [showTemplates, setShowTemplates] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [addingTemplate, setAddingTemplate] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState("");
  const [newTemplateText, setNewTemplateText] = useState("");
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [pendingInstall, setPendingInstall] = useState(false);
  const [installing, setInstalling] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const currentModelInfo = MODEL_OPTIONS.find((m) => m.id === selectedModel) ?? MODEL_OPTIONS[2];

  useEffect(() => {
    if (openTemplates) {
      setShowTemplates(true);
      setOpenTemplates(false);
    }
  }, [openTemplates, setOpenTemplates]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages]);

  // Debounce the meter input (250ms).
  useEffect(() => {
    const t = setTimeout(() => setDebouncedInput(input), 250);
    return () => clearTimeout(t);
  }, [input]);

  // Context-budget meter — recomputed only when the project files, the model,
  // the build-mode history, or the debounced input change (F12). Previously an
  // inline IIFE re-scanned every file's bytes on every render/keystroke.
  const budgetMeter = useMemo(() => {
    const files = currentProject?.files ?? [];
    if (mode !== "build" || files.length === 0) return null;
    // Skip while streaming: updateLastAssistantMessage replaces chatMessages on
    // EVERY chunk, and recomputing the file scan per chunk is O(project bytes).
    // The input is disabled during generation anyway, so the meter isn't needed.
    if (isGenerating) return null;
    const history = chatMessages
      .filter((m) => m.mode === "build")
      .slice(-8)
      .map((m) => ({ content: m.content }));
    const { selected, omitted } = selectFilesForContext(files, debouncedInput);
    const budget = estimateRequestBudget(selected, history, debouncedInput, selectedModel);
    return { selected, omitted, budget, totalFiles: files.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProject?.id, currentProject?.files, mode, isGenerating, chatMessages, debouncedInput, selectedModel]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 144) + "px";
  }, [input]);

  const requestNotificationPermission = useCallback(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, []);

  useEffect(() => {
    requestNotificationPermission();
  }, [requestNotificationPermission]);

  const showCompletionNotification = (summary: string) => {
    if ("Notification" in window && Notification.permission === "granted" && document.hidden) {
      new Notification("Gostera — Generation complete", {
        body: summary.slice(0, 100),
        icon: "/logo.png",
      });
    }
  };

  const handleCancel = () => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setIsGenerating(false);
  };

  // ── F2 staleness guard ────────────────────────────────────────────────────
  // Has the disk folder changed since the store last synced? (e.g. an agent run
  // wrote files that weren't loaded back in). Compares a cheap size fingerprint.
  const diskHasDiverged = useCallback(async (project: Project): Promise<boolean> => {
    if (!project.folderPath || project.files.length === 0) return false;
    try {
      const res = await fetch(`/api/projects/fingerprint?folderPath=${encodeURIComponent(project.folderPath)}`);
      if (!res.ok) return false;
      const { fingerprint, exists } = (await res.json()) as { fingerprint: string | null; exists: boolean };
      if (!exists || !fingerprint) return false;
      const enc = new TextEncoder();
      const storeFp = fingerprintFileSizes(
        project.files.map((f) => ({ path: f.path, size: enc.encode(f.content).length }))
      );
      return storeFp !== fingerprint;
    } catch {
      return false; // never block generation on a fingerprint failure
    }
  }, []);

  const syncFromDiskInChat = useCallback(async (project: Project) => {
    if (!project.folderPath) return;
    try {
      const res = await fetch(`/api/projects/files?folderPath=${encodeURIComponent(project.folderPath)}`);
      if (!res.ok) return;
      const { files, truncated } = (await res.json()) as {
        files: { path: string; content: string }[];
        truncated?: boolean;
      };
      updateFiles(files, truncated ? `Synced from disk (first ${files.length} files)` : "Synced from disk");
    } catch { /* ignore */ }
  }, [updateFiles]);

  const handleSend = async () => {
    if (!input.trim() || isGenerating || !currentProject) return;
    const prompt = input.trim();
    const images = [...pendingImages];

    // Before merging a Generate result onto a folder-backed project, make sure
    // the store isn't stale relative to disk — otherwise we'd silently overwrite
    // changes an agent wrote. (F2)
    if (mode === "build" && (await diskHasDiverged(currentProject))) {
      const syncFirst = window.confirm(
        "The project folder on disk has changed since Gostera last loaded it — an agent run may have written files that aren't reflected here.\n\n" +
        "OK: load those disk changes now (your prompt is kept — press Send again to generate against the fresh files).\n\n" +
        "Cancel: generate anyway (this may overwrite the disk changes)."
      );
      if (syncFirst) {
        await syncFromDiskInChat(currentProject);
        return; // keep input so the user can resend
      }
    }

    setInput("");
    setPendingImages([]);
    addChatMessage({ projectId: currentProject.id, role: "user", content: prompt, mode });
    if (mode === "build") await runGenerate(prompt, images);
    else await runDiscuss(prompt);
  };

  const runGenerate = async (prompt: string, images: PendingImage[]) => {
    if (!currentProject) return;
    setIsGenerating(true);
    addChatMessage({ projectId: currentProject.id, role: "assistant", content: "", mode: "build" });

    const controller = new AbortController();
    abortControllerRef.current = controller;

    // Build conversation history (summaries only, not raw JSON)
    const history = chatMessages
      .filter((m) => m.mode === "build")
      .slice(-8)
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    // Smart file selection — skip when full context mode is active
    const { selected: filesToSend, omitted: omittedFiles } = fullContextMode
      ? { selected: currentProject.files, omitted: [] }
      : selectFilesForContext(currentProject.files, prompt);

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          prompt,
          framework: currentProject.framework,
          existingFiles: filesToSend,
          omittedFiles,
          model: selectedModel,
          history,
          images: images.map((img) => ({ data: img.data, mediaType: img.mediaType })),
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Generation failed" }));
        throw new Error(err.error ?? "Generation failed");
      }

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let accumulated = "";

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          accumulated += decoder.decode(value, { stream: true });
          updateLastAssistantMessage(accumulated);
        }
      }

      const { body, usage, rateLimit } = splitTrailers(accumulated);
      if (rateLimit) setRateLimits(rateLimit);
      let result = parseGenerationResponse(body);

      // Truncation resilience: if the JSON didn't parse (commonly because the
      // response hit max_tokens mid-file), salvage every complete file instead
      // of discarding the whole — full-price — generation. (F6)
      let salvageNote = "";
      if (!result) {
        const salvaged = salvageGenerationResponse(body);
        if (salvaged) {
          result = salvaged.result;
          const truncated = usage?.stop_reason === "max_tokens";
          salvageNote =
            `\n\n> ⚠️ The response was ${truncated ? "cut off at the output token limit" : "incomplete"}. ` +
            `Recovered ${salvaged.recovered} complete file${salvaged.recovered !== 1 ? "s" : ""} — some may be missing. ` +
            `Re-run to fill in the rest, or pick a model with a larger output limit (Sonnet 4.6 / Opus 4.8).`;
        }
      }

      if (result) {
        // Total "in" stays comparable to pre-caching figures (uncached + cached),
        // but the COST bills cache reads at the discounted cache-read rate. (F16)
        const cacheRead = usage?.cache_read_tokens ?? 0;
        const costNote = usage
          ? ` *(${(usage.input_tokens + cacheRead).toLocaleString()} in / ${usage.output_tokens.toLocaleString()} out · ${formatCost(estimateCost(usage.input_tokens, usage.output_tokens, selectedModel, cacheRead))})*`
          : "";
        updateLastAssistantMessage(result.summary + salvageNote + costNote);

        // Apply changes — full replacement for new projects, merge for updates
        const shortDesc = prompt.slice(0, 60);
        if (result.isPartialUpdate && result.changedFiles) {
          mergeFiles(result.changedFiles, result.deletedFiles ?? [], shortDesc);
        } else if (result.files) {
          updateFiles(result.files, shortDesc);
        }

        if (usage) {
          addGenerationLog({
            projectId: currentProject.id,
            prompt: prompt.slice(0, 200),
            framework: currentProject.framework,
            tokensInput: usage.input_tokens + cacheRead,
            tokensOutput: usage.output_tokens,
            cost: estimateCost(usage.input_tokens, usage.output_tokens, selectedModel, cacheRead),
          });
        }

        // Attach the affected files to the chat message for the "Recent Changes" list
        const affectedFiles = result.isPartialUpdate
          ? (result.changedFiles ?? [])
          : (result.files ?? []);

        useProjectStore.setState((state) => {
          const msgs = [...state.chatMessages];
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === "assistant") {
              msgs[i] = { ...msgs[i], files: affectedFiles };
              return { chatMessages: msgs };
            }
          }
          return {};
        });

        showCompletionNotification(result.summary);

        // Detect if dependency files changed → prompt to install
        const depFiles = ["package.json", "requirements.txt", "pyproject.toml"];
        const allAffected = result.isPartialUpdate
          ? (result.changedFiles ?? [])
          : (result.files ?? []);
        const depsChanged = allAffected.some((f) => depFiles.includes(f.path));
        if (depsChanged && currentProject.folderPath) {
          setPendingInstall(true);
        }
      } else if (usage?.stop_reason === "max_tokens") {
        updateLastAssistantMessage(
          "The response was cut off at the output token limit before any complete file could be recovered. " +
          "Try a more targeted request, or switch to a model with a larger output limit (Sonnet 4.6 / Opus 4.8)."
        );
      } else {
        updateLastAssistantMessage(body || "No response received. Please try again.");
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        updateLastAssistantMessage("Generation cancelled.");
        return;
      }
      const message = err instanceof Error ? err.message : "Unknown error";
      updateLastAssistantMessage(`Error: ${message}`);
    } finally {
      abortControllerRef.current = null;
      setIsGenerating(false);
    }
  };

  const runDiscuss = async (prompt: string) => {
    if (!currentProject) return;
    setIsGenerating(true);
    addChatMessage({ projectId: currentProject.id, role: "assistant", content: "", mode: "discuss" });

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const res = await fetch("/api/discuss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          message: prompt,
          files: currentProject.files,
          history: chatMessages.slice(-10).map((m) => ({
            role: m.role === "user" ? "user" : "assistant",
            content: m.content,
          })),
          model: selectedModel,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Discussion failed" }));
        throw new Error(err.error ?? "Discussion failed");
      }

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let accumulated = "";

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          accumulated += decoder.decode(value, { stream: true });
          // Render without the (end-of-stream) rate-limit trailer.
          updateLastAssistantMessage(splitTrailers(accumulated).body);
        }
      }

      const { body: discussBody, rateLimit } = splitTrailers(accumulated);
      if (rateLimit) setRateLimits(rateLimit);
      updateLastAssistantMessage(discussBody);
      showCompletionNotification(discussBody.slice(0, 100));
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        updateLastAssistantMessage("Generation cancelled.");
        return;
      }
      const message = err instanceof Error ? err.message : "Unknown error";
      updateLastAssistantMessage(`Error: ${message}`);
    } finally {
      abortControllerRef.current = null;
      setIsGenerating(false);
    }
  };

  const handleInstall = async () => {
    if (!currentProject?.folderPath) return;
    setInstalling(true);
    setPendingInstall(false);
    addChatMessage({
      projectId: currentProject.id,
      role: "assistant",
      content: `Running \`${currentProject.framework === "python-flask" ? "pip install -r requirements.txt" : "npm install"}\` in ${currentProject.folderPath}…`,
      mode: "build",
    });
    try {
      const res = await fetch("/api/projects/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          folderPath: currentProject.folderPath,
          framework: currentProject.framework,
        }),
      });
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let output = "";
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          output += decoder.decode(value, { stream: true });
          const displayOutput = output
            .replace(/\n\n__INSTALL_DONE__.*$/, "")
            .trim();
          updateLastAssistantMessage(
            "```\n" + displayOutput.slice(-2000) + "\n```"
          );
        }
      }
      const doneIdx = output.lastIndexOf("__INSTALL_DONE__");
      if (doneIdx !== -1) {
        try {
          const { code } = JSON.parse(output.slice(doneIdx + "__INSTALL_DONE__".length));
          const finalMsg = code === 0
            ? "✅ Dependencies installed successfully."
            : `⚠️ Install exited with code ${code}. Check the output above.`;
          updateLastAssistantMessage(
            "```\n" + output.replace(/\n\n__INSTALL_DONE__.*$/, "").trim().slice(-2000) + "\n```\n\n" + finalMsg
          );
        } catch { /* ignore */ }
      }
    } catch (err: unknown) {
      updateLastAssistantMessage(`Install error: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setInstalling(false);
    }
  };

  const handleRetry = () => {
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      if (chatMessages[i].role === "user") {
        const lastPrompt = chatMessages[i].content;
        if (mode === "build") runGenerate(lastPrompt, []);
        else runDiscuss(lastPrompt);
        return;
      }
    }
  };

  const handleAddTemplate = () => {
    if (!newTemplateName.trim() || !newTemplateText.trim()) return;
    addPromptTemplate({ label: newTemplateName.trim(), text: newTemplateText.trim() });
    setNewTemplateName("");
    setNewTemplateText("");
    setAddingTemplate(false);
  };

  const handleFileAttach = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const isText =
      file.type.startsWith("text/") ||
      /\.(json|ts|tsx|js|jsx|css|html|md|py|go|rs|java|c|cpp|h|sh|env|yaml|yml|toml|xml|svg)$/i.test(file.name);
    if (isText) {
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
    } else {
      setInput((prev) =>
        prev ? `${prev}\n[Attached: ${file.name}]` : `[Attached: ${file.name}]`
      );
    }
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
      // dataUrl is "data:image/png;base64,XXXX" — extract just the base64 part
      const base64 = dataUrl.split(",")[1];
      setPendingImages((prev) => [
        ...prev,
        { name: file.name, data: base64, mediaType, preview: dataUrl },
      ]);
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  const removePendingImage = (name: string) => {
    setPendingImages((prev) => prev.filter((img) => img.name !== name));
  };

  const charCount = input.length;
  const charLimit = mode === "build" ? 12000 : 8000;
  const charWarning = charCount > charLimit * 0.85;

  return (
    <div className="flex flex-col h-full bg-card">
      {/* Hidden file inputs */}
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={handleFileAttach}
        accept=".txt,.json,.ts,.tsx,.js,.jsx,.css,.html,.md,.py,.go,.rs,.java,.c,.cpp,.h,.sh,.env,.yaml,.yml,.toml,.xml,.svg,.csv"
      />
      <input
        ref={imageInputRef}
        type="file"
        className="hidden"
        accept="image/jpeg,image/png,image/gif,image/webp"
        onChange={handleImageAttach}
      />

      {/* Panel header */}
      <div className="flex items-center justify-between px-3 h-10 border-b border-border shrink-0 border-t-2 border-t-primary">
        {/* Generate / Agent mode toggle */}
        <div className="flex bg-muted/60 rounded-lg p-0.5 gap-0.5">
          <button
            onClick={() => setGenerationMode("generate")}
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold rounded-md transition-colors",
              generationMode === "generate"
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Zap className="h-3 w-3" /> Generate
          </button>
          <button
            onClick={() => setGenerationMode("agent")}
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold rounded-md transition-colors",
              generationMode === "agent"
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Bot className="h-3 w-3" /> Agent
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          {/* Subscription / API credential badge (+ quick rate-limit hint) */}
          <AuthBadge />
          {/* Full context mode toggle — only relevant in Generate mode */}
          {generationMode === "generate" && (
            <button
              onClick={toggleFullContextMode}
              title={fullContextMode ? "Full context mode ON — sending all files" : "Smart mode — auto-selects relevant files"}
              className={cn(
                "flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded transition-colors",
                fullContextMode
                  ? "bg-yellow-500/15 text-yellow-400 hover:bg-yellow-500/25"
                  : "text-muted-foreground hover:text-primary"
              )}
            >
              <Layers className="h-3 w-3" />
              {fullContextMode ? "Full" : "Smart"}
            </button>
          )}
          <button
            onClick={() => setShowUsageModal(true)}
            className="text-muted-foreground hover:text-primary transition-colors"
            title="Usage stats"
          >
            <BarChart3 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Agent mode — render AgentPanel instead of chat */}
      {generationMode === "agent" && <AgentPanel />}

      {/* Generate mode — only render when not in agent mode */}
      {generationMode === "generate" && <>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-thin">
        {chatMessages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center gap-3">
            <Image
              src="/logo.png"
              alt="Gostera"
              width={48}
              height={48}
              className="w-12 h-12"
            />
            <div>
              <p className="text-sm font-semibold text-foreground">Gostera AI</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {mode === "build"
                  ? "Describe what you want to build"
                  : "Ask me anything about your project"}
              </p>
            </div>
          </div>
        )}

        {chatMessages.map((msg, i) => {
          const isLastMsg = i === chatMessages.length - 1;
          const isStreaming = isGenerating && isLastMsg && msg.role === "assistant";

          return (
            <div
              key={msg.id}
              className={cn(
                "flex flex-col gap-2",
                msg.role === "user" ? "items-end" : "items-start"
              )}
            >
              {msg.role === "user" ? (
                <div className="max-w-[85%] rounded-2xl rounded-tr-sm px-4 py-2.5 bg-primary/10 border border-primary/20 text-sm text-foreground leading-relaxed whitespace-pre-wrap">
                  {msg.content}
                </div>
              ) : (
                <div className="max-w-[95%] space-y-2 w-full">
                  <div className="flex items-center gap-2">
                    <Image
                      src="/logo.png"
                      alt=""
                      width={20}
                      height={20}
                      className="w-5 h-5 shrink-0"
                    />
                    <span className="text-[10px] font-bold uppercase tracking-wider text-primary">
                      Gostera AI
                    </span>
                    <span className={cn(
                      "text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded font-semibold",
                      msg.mode === "discuss"
                        ? "bg-blue-500/10 text-blue-400"
                        : "bg-primary/10 text-primary"
                    )}>
                      {msg.mode === "discuss" ? "Discuss" : "Build"}
                    </span>
                  </div>

                  <div className={cn(
                    "rounded-2xl rounded-tl-sm px-4 py-3 text-sm leading-relaxed bg-muted/50 border border-border",
                    msg.mode === "discuss" && "border-l-2 border-l-blue-400/60"
                  )}>
                    {msg.content ? (
                      <div className="prose prose-sm dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={{
                            code({ className, children, ...props }) {
                              const isBlock = className?.includes("language-");
                              if (isBlock) {
                                return (
                                  <pre className="bg-background/60 border border-border rounded-lg p-3 overflow-x-auto my-2">
                                    <code className="text-[11px] font-mono text-foreground" {...props}>
                                      {children}
                                    </code>
                                  </pre>
                                );
                              }
                              return (
                                <code className="bg-background/60 border border-border rounded px-1.5 py-0.5 text-[11px] font-mono text-primary" {...props}>
                                  {children}
                                </code>
                              );
                            },
                            p({ children }) {
                              return <p className="text-foreground mb-2 last:mb-0">{children}</p>;
                            },
                            ul({ children }) {
                              return <ul className="list-disc pl-4 mb-2 space-y-0.5">{children}</ul>;
                            },
                            ol({ children }) {
                              return <ol className="list-decimal pl-4 mb-2 space-y-0.5">{children}</ol>;
                            },
                            li({ children }) {
                              return <li className="text-foreground text-sm">{children}</li>;
                            },
                            strong({ children }) {
                              return <strong className="font-semibold text-foreground">{children}</strong>;
                            },
                            a({ href, children }) {
                              return <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline">{children}</a>;
                            },
                          }}
                        >
                          {msg.content}
                        </ReactMarkdown>
                      </div>
                    ) : isStreaming ? (
                      <span className="flex gap-1 items-center text-primary">
                        <span className="w-1.5 h-1.5 bg-primary rounded-full animate-bounce" />
                        <span className="w-1.5 h-1.5 bg-primary rounded-full animate-bounce [animation-delay:0.15s]" />
                        <span className="w-1.5 h-1.5 bg-primary rounded-full animate-bounce [animation-delay:0.3s]" />
                      </span>
                    ) : (
                      <span className="text-muted-foreground italic text-xs">No response</span>
                    )}
                  </div>

                  {msg.files && msg.files.length > 0 && msg.mode === "build" && (
                    <div className="bg-muted/30 border border-border rounded-lg px-3 py-2 space-y-1.5">
                      <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                        Recent Changes
                      </p>
                      <div className="space-y-0.5">
                        {msg.files.slice(0, 6).map((f) => (
                          <div key={f.path} className="flex items-center gap-1.5 text-xs">
                            <span className="text-primary text-[10px]">●</span>
                            <span className="text-muted-foreground">
                              {f.path.includes("/") ? (
                                <>
                                  <span className="text-muted-foreground/50">
                                    {f.path.split("/").slice(0, -1).join("/")}/
                                  </span>
                                  <span className="text-primary font-mono font-medium">
                                    {f.path.split("/").pop()}
                                  </span>
                                </>
                              ) : (
                                <span className="text-primary font-mono font-medium">{f.path}</span>
                              )}
                            </span>
                          </div>
                        ))}
                        {msg.files.length > 6 && (
                          <p className="text-[10px] text-muted-foreground/60 pl-3">
                            +{msg.files.length - 6} more files
                          </p>
                        )}
                      </div>
                    </div>
                  )}

                  {!isStreaming && isLastMsg && msg.content.startsWith("Error:") && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs gap-1.5"
                      onClick={handleRetry}
                    >
                      <RefreshCw className="h-3 w-3" /> Retry
                    </Button>
                  )}
                </div>
              )}
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="border-t border-border bg-card shrink-0">
        {/* Model selector */}
        <div className="relative px-3 pt-2">
          <button
            onClick={() => setShowModelPicker(!showModelPicker)}
            className="flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-primary transition-colors group"
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
                  <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                    Select Model
                  </p>
                </div>
                {MODEL_OPTIONS.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => { setSelectedModel(m.id); setShowModelPicker(false); }}
                    className={cn(
                      "w-full flex items-center justify-between px-3 py-2.5 text-left hover:bg-accent/50 transition-colors",
                      selectedModel === m.id && "bg-primary/10"
                    )}
                  >
                    <div>
                      <p className={cn(
                        "text-sm font-medium",
                        selectedModel === m.id ? "text-primary" : "text-foreground"
                      )}>
                        {m.label}
                      </p>
                      <p className="text-[11px] text-muted-foreground">{m.description}</p>
                    </div>
                    <span className={cn(
                      "text-[9px] font-bold px-1.5 py-0.5 rounded uppercase shrink-0 ml-2",
                      selectedModel === m.id
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground"
                    )}>
                      {m.badge}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Mode + Templates row */}
        <div className="flex items-center justify-between px-3 py-1.5">
          <div className="flex bg-muted rounded-lg p-0.5 gap-0.5">
            <button
              onClick={() => setMode("build")}
              className={cn(
                "px-3 py-1 text-xs rounded-md font-semibold transition-colors",
                mode === "build"
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              Build
            </button>
            <button
              onClick={() => setMode("discuss")}
              className={cn(
                "px-3 py-1 text-xs rounded-md font-semibold transition-colors",
                mode === "discuss"
                  ? "bg-blue-500 text-white shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              Discuss
            </button>
          </div>

          <div className="relative">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs gap-1 text-muted-foreground hover:text-primary"
              onClick={() => setShowTemplates(!showTemplates)}
            >
              Templates <ChevronDown className={cn("h-3 w-3 transition-transform", showTemplates && "rotate-180")} />
            </Button>
            {showTemplates && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowTemplates(false)} />
                <div className="absolute bottom-full right-0 mb-1 w-64 bg-popover border border-border rounded-xl shadow-2xl z-50 overflow-hidden">
                  <div className="px-3 py-2 border-b border-border">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Prompt Templates</p>
                  </div>
                  <div className="max-h-52 overflow-y-auto scrollbar-thin">
                    {promptTemplates.map((t) => (
                      <div key={t.id} className="flex items-center group hover:bg-accent/50">
                        <button
                          onClick={() => {
                            setInput(t.text);
                            setShowTemplates(false);
                            setTimeout(() => textareaRef.current?.focus(), 0);
                          }}
                          className="flex-1 text-left px-3 py-2 text-sm text-foreground"
                        >
                          {t.label}
                        </button>
                        {t.isCustom && (
                          <button
                            onClick={() => removePromptTemplate(t.id)}
                            className="pr-2 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="border-t border-border p-2">
                    {addingTemplate ? (
                      <div className="space-y-1.5">
                        <input
                          placeholder="Template name"
                          value={newTemplateName}
                          onChange={(e) => setNewTemplateName(e.target.value)}
                          className="w-full text-xs bg-background border border-border rounded px-2 py-1.5 outline-none focus:ring-1 focus:ring-ring"
                          autoFocus
                        />
                        <input
                          placeholder="Template text"
                          value={newTemplateText}
                          onChange={(e) => setNewTemplateText(e.target.value)}
                          className="w-full text-xs bg-background border border-border rounded px-2 py-1.5 outline-none focus:ring-1 focus:ring-ring"
                          onKeyDown={(e) => e.key === "Enter" && handleAddTemplate()}
                        />
                        <div className="flex gap-1">
                          <Button size="sm" className="h-6 text-xs flex-1" onClick={handleAddTemplate}>Add</Button>
                          <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => setAddingTemplate(false)}>Cancel</Button>
                        </div>
                      </div>
                    ) : (
                      <button
                        onClick={() => setAddingTemplate(true)}
                        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground w-full py-0.5"
                      >
                        <Plus className="h-3 w-3" /> Add custom template
                      </button>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        {/* npm/pip install banner */}
        {(pendingInstall || installing) && (
          <div className="mx-3 mb-1 flex items-center gap-2 px-3 py-2 rounded-lg bg-yellow-500/10 border border-yellow-500/30">
            <PackageCheck className="h-3.5 w-3.5 text-yellow-400 shrink-0" />
            <p className="text-xs text-yellow-300 flex-1">
              {installing
                ? "Installing dependencies…"
                : "Dependencies changed. Run install?"}
            </p>
            {!installing && currentProject?.folderPath && (
              <button
                onClick={handleInstall}
                className="text-[10px] font-semibold px-2 py-1 rounded bg-yellow-500/20 text-yellow-300 hover:bg-yellow-500/30 transition-colors shrink-0"
              >
                Run install
              </button>
            )}
            {installing && <Loader2 className="h-3.5 w-3.5 text-yellow-400 animate-spin shrink-0" />}
            {!installing && (
              <button
                onClick={() => setPendingInstall(false)}
                className="text-muted-foreground hover:text-foreground shrink-0"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}

        {/* Pending image thumbnails */}
        {pendingImages.length > 0 && (
          <div className="flex gap-2 px-3 pb-1.5 flex-wrap">
            {pendingImages.map((img) => (
              <div key={img.name} className="relative group">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={img.preview}
                  alt={img.name}
                  className="h-12 w-12 object-cover rounded-md border border-border"
                />
                <button
                  onClick={() => removePendingImage(img.name)}
                  className="absolute -top-1 -right-1 w-4 h-4 bg-destructive rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X className="h-2.5 w-2.5 text-white" />
                </button>
                <span className="sr-only">{img.name}</span>
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
                  handleSend();
                }
              }}
              placeholder={
                mode === "build"
                  ? "How can Gostera help you build today?"
                  : "Ask a question or discuss ideas..."
              }
              rows={2}
              className={cn(
                "flex-1 resize-none bg-muted/50 border border-border rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground/60 scrollbar-thin",
                charWarning && "border-yellow-500/50 focus:ring-yellow-500/50"
              )}
              style={{ maxHeight: 144 }}
              disabled={isGenerating || !currentProject}
            />
            {isGenerating ? (
              <Button
                size="icon"
                className="h-10 w-10 shrink-0 bg-destructive text-white hover:bg-destructive/90 rounded-xl"
                onClick={handleCancel}
                title="Cancel generation"
              >
                <Square className="h-4 w-4" />
              </Button>
            ) : (
              <Button
                size="icon"
                className="h-10 w-10 shrink-0 bg-primary text-primary-foreground hover:bg-primary/90 rounded-xl cyan-glow"
                onClick={handleSend}
                disabled={!input.trim() || !currentProject}
              >
                <Send className="h-4 w-4" />
              </Button>
            )}
          </div>

          {/* Context budget meter — shown in build mode when project has files */}
          {budgetMeter && (() => {
            const { selected, omitted, budget, totalFiles } = budgetMeter;
            const pct = Math.min(100, Math.round(budget.fraction * 100));
            const barColor =
              budget.level === "danger"
                ? "bg-red-500"
                : budget.level === "warn"
                ? "bg-yellow-500"
                : "bg-primary/60";
            const textColor =
              budget.level === "danger"
                ? "text-red-400"
                : budget.level === "warn"
                ? "text-yellow-400"
                : "text-muted-foreground/60";

            return (
              <div className="space-y-1">
                {/* Progress bar */}
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-1 bg-muted/40 rounded-full overflow-hidden">
                    <div
                      className={cn("h-full rounded-full transition-all", barColor)}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className={cn("text-[10px] font-mono shrink-0", textColor)}>
                    {formatTokens(budget.total)} / {formatTokens(budget.contextLimit)}
                  </span>
                </div>

                {/* Omitted files warning */}
                {omitted.length > 0 && (
                  <div className="flex items-center gap-1.5 text-[10px] text-yellow-500/80">
                    <Zap className="h-3 w-3 shrink-0" />
                    <span>
                      {selected.length}/{totalFiles} files fit in context
                      — {omitted.length} large file{omitted.length !== 1 ? "s" : ""} auto-omitted
                    </span>
                  </div>
                )}

                {/* Danger warning */}
                {budget.level === "danger" && omitted.length === 0 && (
                  <p className="text-[10px] text-red-400">
                    Context nearly full — consider working on smaller pieces or switching to a model with a larger output limit.
                  </p>
                )}
              </div>
            );
          })()}

          {/* Bottom bar */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
                title="Attach text file"
              >
                <Paperclip className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => imageInputRef.current?.click()}
                className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
                title="Attach image (sent to Claude vision)"
              >
                <ImageIcon className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="flex items-center gap-2 text-[11px] text-muted-foreground/70">
              {charWarning && (
                <span className="text-yellow-500">
                  {charCount.toLocaleString()}/{charLimit.toLocaleString()} chars
                </span>
              )}
              {input.trim() && mode === "build" && !charWarning && (() => {
                const cost = estimateCost(
                  estimateTokens(input),
                  Math.round(estimateTokens(input) * 2),
                  selectedModel
                );
                return (
                  <span className="flex items-center gap-1">
                    <Zap className="h-3 w-3 text-primary/50" />
                    {formatCost(cost)} est.
                  </span>
                );
              })()}
              <span>Ctrl+Enter to send</span>
            </div>
          </div>
        </div>
      </div>

      {/* End of Generate mode wrapper */}
      </>}
    </div>
  );
}
