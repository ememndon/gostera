/**
 * Smart file selection for context management.
 *
 * When a project's files exceed the token budget, this module scores each
 * file by relevance to the current prompt and greedily picks the best subset
 * that fits — always including core config files and entry points.
 *
 * Context windows (verified against Anthropic docs, 2026):
 *   claude-haiku-4-5-20251001  → 200K input,  8K output
 *   claude-sonnet-4-20250514   → 200K input,  8K output
 *   claude-sonnet-4-6          → 1M input,   64K output
 *   claude-opus-4-8            → 1M input,  128K output
 */

import { estimateTokens } from "./token-estimate";
import type { ProjectFile } from "./types";

// ─── Limits ──────────────────────────────────────────────────────────────────

/**
 * Tokens reserved for project files when choosing which files to include.
 * Kept at 200K as a cost-conscious default (the full 1M context is available
 * on newer models, but we don't want to routinely send 800K tokens of files
 * — that would be extremely expensive per request).
 * With incremental updates, most requests only touch a handful of files anyway.
 */
export const FILE_TOKEN_BUDGET = 200_000;

/**
 * Context window size per model. Used for the budget meter in the UI.
 * Haiku and old Sonnet cap at 200K; newer models have 1M.
 */
export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  "claude-haiku-4-5-20251001": 200_000,
  "claude-sonnet-4-20250514":  200_000,
  "claude-sonnet-4-6":       1_000_000,
  "claude-opus-4-8":         1_000_000,
  "gemini-3.5-flash":        1_000_000,
};

/** Fallback context limit used when model isn't specified. */
export const CONTEXT_LIMIT = 1_000_000;

/** Rough overhead: system prompt + formatting + JSON structure. */
export const SYSTEM_OVERHEAD_TOKENS = 2_000;

/** Rough per-history-message overhead. */
export const PER_MESSAGE_TOKENS = 600;

// ─── File scoring weights ─────────────────────────────────────────────────────

const CORE_FILES = new Set([
  "package.json", "pyproject.toml", "requirements.txt",
  "tsconfig.json", "jsconfig.json",
  "vite.config.ts", "vite.config.js",
  "next.config.mjs", "next.config.js", "next.config.ts",
  "tailwind.config.ts", "tailwind.config.js",
  "app.py", "main.py", "server.py",
  "index.html", "dockerfile", "makefile",
]);

const ENTRY_FILES = new Set([
  "app.tsx", "app.jsx", "app.vue", "app.svelte",
  "page.tsx", "page.jsx",
  "main.tsx", "main.jsx", "main.ts", "main.js",
  "index.tsx", "index.jsx", "index.ts", "index.js",
  "layout.tsx", "layout.jsx",
  "globals.css", "global.css", "index.css",
]);

// ─── Per-file token cache ─────────────────────────────────────────────────────
//
// File objects are replaced immutably whenever content changes (the stores
// always build new ProjectFile objects), so a WeakMap keyed on the object is a
// safe memo: unchanged files hit the cache, edited files are new keys, and old
// entries are garbage-collected with their files. This turns the selector and
// budget meter from O(total project bytes) per call into O(changed bytes). (F12)

const fileTokenCache = new WeakMap<ProjectFile, number>();

function fileTokens(file: ProjectFile): number {
  let tokens = fileTokenCache.get(file);
  if (tokens === undefined) {
    tokens = estimateTokens(file.content);
    fileTokenCache.set(file, tokens);
  }
  return tokens;
}

function totalFileTokens(files: ProjectFile[]): number {
  let sum = 0;
  for (const f of files) sum += fileTokens(f);
  return sum;
}

// ─── Selection algorithm ──────────────────────────────────────────────────────

export interface SelectionResult {
  selected: ProjectFile[];
  omitted: string[];
  selectedTokens: number;
  totalFileTokens: number;
  wasFiltered: boolean;
}

export function selectFilesForContext(
  files: ProjectFile[],
  prompt: string,
  budget: number = FILE_TOKEN_BUDGET
): SelectionResult {
  const allFileTokens = totalFileTokens(files);

  if (allFileTokens <= budget) {
    return {
      selected: files,
      omitted: [],
      selectedTokens: allFileTokens,
      totalFileTokens: allFileTokens,
      wasFiltered: false,
    };
  }

  const promptLower = prompt.toLowerCase();
  const promptWords = new Set(
    promptLower.split(/\W+/).filter((w) => w.length > 2)
  );

  const scored = files.map((file) => {
    const parts = file.path.split("/");
    const fileName = (parts[parts.length - 1] ?? "").toLowerCase();
    const ext = fileName.split(".").pop() ?? "";
    const pathLower = file.path.toLowerCase();
    let score = 0;

    if (CORE_FILES.has(fileName)) score += 20;
    if (ENTRY_FILES.has(fileName)) score += 15;

    promptWords.forEach((word) => {
      if (pathLower.includes(word)) score += 6;
    });

    if (/style|color|design|layout|theme|dark|light|font|margin|padding/.test(promptLower)) {
      if (["css", "scss", "sass", "less"].includes(ext)) score += 5;
    }
    if (/api|route|endpoint|fetch|request|server|backend|handler/.test(promptLower)) {
      if (pathLower.includes("api/") || pathLower.includes("route") || pathLower.includes("handler")) score += 5;
    }
    if (/component|button|modal|form|input|card|nav|header|footer|sidebar/.test(promptLower)) {
      if (pathLower.includes("component") || pathLower.includes("ui/") || pathLower.includes("widget")) score += 5;
    }
    if (/auth|login|logout|session|token|user|password/.test(promptLower)) {
      if (pathLower.includes("auth") || pathLower.includes("login") || pathLower.includes("user")) score += 5;
    }
    if (/database|db|model|schema|migration|query/.test(promptLower)) {
      if (pathLower.includes("db") || pathLower.includes("model") || pathLower.includes("schema") || ext === "sql" || ext === "prisma") score += 5;
    }

    score += Math.max(0, 4 - parts.length);

    return { file, score, fileTokens: fileTokens(file) };
  });

  scored.sort((a, b) => b.score - a.score);

  const selected: ProjectFile[] = [];
  const omitted: string[] = [];
  let usedTokens = 0;

  for (const { file, fileTokens } of scored) {
    if (usedTokens + fileTokens <= budget) {
      selected.push(file);
      usedTokens += fileTokens;
    } else {
      omitted.push(file.path);
    }
  }

  return {
    selected,
    omitted,
    selectedTokens: usedTokens,
    totalFileTokens: allFileTokens,
    wasFiltered: true,
  };
}

// ─── Full request token estimate ──────────────────────────────────────────────

export interface RequestBudget {
  total: number;
  breakdown: {
    systemPrompt: number;
    files: number;
    history: number;
    prompt: number;
  };
  fraction: number;
  /** "ok" | "warn" | "danger" */
  level: "ok" | "warn" | "danger";
  contextLimit: number;
}

export function estimateRequestBudget(
  files: ProjectFile[],
  historyMessages: { content: string }[],
  prompt: string,
  model?: string
): RequestBudget {
  const contextLimit = model
    ? (MODEL_CONTEXT_LIMITS[model] ?? CONTEXT_LIMIT)
    : CONTEXT_LIMIT;

  const systemPrompt = SYSTEM_OVERHEAD_TOKENS;
  const filesTokens = totalFileTokens(files);
  const historyTokens = historyMessages.reduce(
    (sum, m) => sum + estimateTokens(m.content) + PER_MESSAGE_TOKENS,
    0
  );
  const promptTokens = estimateTokens(prompt);
  const total = systemPrompt + filesTokens + historyTokens + promptTokens;
  const fraction = total / contextLimit;

  // Thresholds are proportional to the context limit, not absolute
  const level = fraction > 0.85 ? "danger" : fraction > 0.6 ? "warn" : "ok";

  return {
    total,
    breakdown: { systemPrompt, files: filesTokens, history: historyTokens, prompt: promptTokens },
    fraction,
    level,
    contextLimit,
  };
}
