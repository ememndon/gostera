import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Framework } from "@/lib/types";
import type { AuthMode, RateLimitTrailer } from "@/lib/rate-limits";

// Historical name — the union now spans providers (Claude + Gemini).
export type ClaudeModel =
  | "claude-haiku-4-5-20251001"
  | "claude-sonnet-4-20250514"
  | "claude-sonnet-4-6"
  | "claude-opus-4-8"
  | "gemini-3.5-flash";

export type ModelProvider = "claude" | "gemini";

export const MODEL_OPTIONS: { id: ClaudeModel; label: string; badge: string; description: string; provider: ModelProvider }[] = [
  {
    id: "claude-haiku-4-5-20251001",
    label: "Claude Haiku 4.5",
    badge: "FAST",
    description: "Fastest · 200K context · 64K output",
    provider: "claude",
  },
  {
    id: "claude-sonnet-4-20250514",
    label: "Claude Sonnet 4",
    badge: "BALANCED",
    description: "Balanced · 200K context · 64K output",
    provider: "claude",
  },
  {
    id: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    badge: "RECOMMENDED",
    description: "Best for coding · 1M context · 64K output",
    provider: "claude",
  },
  {
    id: "claude-opus-4-8",
    label: "Claude Opus 4.8",
    badge: "MAX",
    description: "Most capable · 1M context · 128K output",
    provider: "claude",
  },
  {
    id: "gemini-3.5-flash",
    label: "Gemini 3.5 Flash",
    badge: "FREE",
    description: "Google free tier · 1M context · 64K output · ~1,500 req/day",
    provider: "gemini",
  },
];

interface UIState {
  sidebarOpen: boolean;
  codeEditorOpen: boolean;
  mode: "build" | "discuss";
  selectedFramework: Framework;
  selectedModel: ClaudeModel;
  activeFile: string | null;
  isGenerating: boolean;
  previewDevice: "mobile" | "tablet" | "desktop";
  activeTopTab: "dashboard" | "templates" | "marketplace";
  openTemplates: boolean;
  previewFullscreen: boolean;
  showUsageModal: boolean;
  /** When true, all project files are sent to Claude regardless of context budget */
  fullContextMode: boolean;
  /** Local dev server URL per project (e.g. "http://localhost:3000") — not persisted */
  localServerUrl: string;
  /** Whether to use the single-shot generation system or the agent loop */
  generationMode: "generate" | "agent";
  /** Which Claude credential is active (from /api/status). Not persisted. */
  authMode: AuthMode;
  /** Latest rate-limit snapshot from the most recent Claude call. Not persisted. */
  rateLimits: RateLimitTrailer | null;

  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  toggleCodeEditor: () => void;
  setCodeEditorOpen: (open: boolean) => void;
  setMode: (mode: "build" | "discuss") => void;
  toggleMode: () => void;
  setFramework: (framework: Framework) => void;
  setSelectedModel: (model: ClaudeModel) => void;
  setActiveFile: (path: string | null) => void;
  setIsGenerating: (generating: boolean) => void;
  setPreviewDevice: (device: "mobile" | "tablet" | "desktop") => void;
  setActiveTopTab: (tab: "dashboard" | "templates" | "marketplace") => void;
  setOpenTemplates: (open: boolean) => void;
  setPreviewFullscreen: (fullscreen: boolean) => void;
  setShowUsageModal: (show: boolean) => void;
  toggleFullContextMode: () => void;
  setLocalServerUrl: (url: string) => void;
  setGenerationMode: (mode: "generate" | "agent") => void;
  setAuthMode: (mode: AuthMode) => void;
  setRateLimits: (rl: RateLimitTrailer | null) => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      sidebarOpen: true,
      codeEditorOpen: false,
      mode: "build",
      selectedFramework: "html-css-js",
      selectedModel: "claude-sonnet-4-6",
      activeFile: null,
      isGenerating: false,
      previewDevice: "desktop",
      activeTopTab: "dashboard",
      openTemplates: false,
      previewFullscreen: false,
      showUsageModal: false,
      fullContextMode: false,
      localServerUrl: "",
      generationMode: "generate",
      authMode: "unknown",
      rateLimits: null,

      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      setSidebarOpen: (open) => set({ sidebarOpen: open }),
      toggleCodeEditor: () => set((s) => ({ codeEditorOpen: !s.codeEditorOpen })),
      setCodeEditorOpen: (open) => set({ codeEditorOpen: open }),
      setMode: (mode) => set({ mode }),
      toggleMode: () => set((s) => ({ mode: s.mode === "build" ? "discuss" : "build" })),
      setFramework: (framework) => set({ selectedFramework: framework }),
      setSelectedModel: (model) => set({ selectedModel: model }),
      setActiveFile: (path) => set({ activeFile: path }),
      setIsGenerating: (generating) => set({ isGenerating: generating }),
      setPreviewDevice: (device) => set({ previewDevice: device }),
      setActiveTopTab: (tab) => set({ activeTopTab: tab }),
      setOpenTemplates: (open) => set({ openTemplates: open }),
      setPreviewFullscreen: (fullscreen) => set({ previewFullscreen: fullscreen }),
      setShowUsageModal: (show) => set({ showUsageModal: show }),
      toggleFullContextMode: () => set((s) => ({ fullContextMode: !s.fullContextMode })),
      setLocalServerUrl: (url) => set({ localServerUrl: url }),
      setGenerationMode: (mode) => set({ generationMode: mode }),
      setAuthMode: (mode) => set({ authMode: mode }),
      setRateLimits: (rl) => set({ rateLimits: rl }),
    }),
    {
      name: "gostera-ui",
      partialize: (state) => ({
        sidebarOpen: state.sidebarOpen,
        codeEditorOpen: state.codeEditorOpen,
        mode: state.mode,
        selectedFramework: state.selectedFramework,
        selectedModel: state.selectedModel,
        previewDevice: state.previewDevice,
        activeTopTab: state.activeTopTab,
        fullContextMode: state.fullContextMode,
        generationMode: state.generationMode,
        // localServerUrl intentionally not persisted — user sets it per session
      }),
    }
  )
);
