import type { ProjectFile } from "./types";
import type { RateLimitTrailer } from "./rate-limits";

export interface GenerationResult {
  summary: string;
  /**
   * Full file set — returned for brand-new projects (schema: `files`).
   * When present, replaces all existing project files.
   */
  files?: ProjectFile[];
  /**
   * Partial file set — returned for updates to existing projects (schema: `changedFiles`).
   * When present, these are merged into the existing file set.
   */
  changedFiles?: ProjectFile[];
  /**
   * Paths to remove from the project — only used with changedFiles mode.
   */
  deletedFiles?: string[];
  /** True when this response is an incremental update, false when it's a full replacement. */
  isPartialUpdate: boolean;
  instructions?: string;
  dependencies?: Record<string, string>;
}

export interface UsageData {
  /** Uncached input tokens + cache-creation tokens (billed ≈ input rate). */
  input_tokens: number;
  output_tokens: number;
  /** Tokens served from the prompt cache — billed at the ~90%-discounted cache-read rate. (F16) */
  cache_read_tokens?: number;
  /** Present on generate responses; "max_tokens" signals a truncated reply. */
  stop_reason?: string | null;
}

/**
 * Splits off the __USAGE__ trailer appended by the generate route.
 */
export function splitUsageTrailer(raw: string): { body: string; usage: UsageData | null } {
  const idx = raw.lastIndexOf("\n\n__USAGE__");
  if (idx === -1) return { body: raw, usage: null };
  try {
    const usage = JSON.parse(raw.slice(idx + "\n\n__USAGE__".length));
    return { body: raw.slice(0, idx), usage };
  } catch {
    return { body: raw, usage: null };
  }
}

/** Peel one `\n\n<MARKER>{json}` trailer off the end of a stream body. */
function peelTrailer<T>(raw: string, marker: string): { rest: string; data: T | null } {
  const token = `\n\n${marker}`;
  const idx = raw.lastIndexOf(token);
  if (idx === -1) return { rest: raw, data: null };
  try {
    return { rest: raw.slice(0, idx), data: JSON.parse(raw.slice(idx + token.length)) as T };
  } catch {
    return { rest: raw, data: null };
  }
}

/**
 * Split off BOTH trailers a generation stream may carry.
 * Order matters: __RATELIMIT__ is appended last, so it is peeled first.
 */
export function splitTrailers(raw: string): {
  body: string;
  usage: UsageData | null;
  rateLimit: RateLimitTrailer | null;
} {
  const rl = peelTrailer<RateLimitTrailer>(raw, "__RATELIMIT__");
  const u = peelTrailer<UsageData>(rl.rest, "__USAGE__");
  return { body: u.rest, usage: u.data, rateLimit: rl.data };
}

function isValidFile(f: unknown): f is ProjectFile {
  return (
    typeof f === "object" &&
    f !== null &&
    typeof (f as ProjectFile).path === "string" &&
    typeof (f as ProjectFile).content === "string"
  );
}

/**
 * Extracts JSON from Claude's response.
 * Handles both full-generation (`files`) and incremental-update (`changedFiles`) schemas.
 */
export function parseGenerationResponse(raw: string): GenerationResult | null {
  // Strip markdown code fences
  let cleaned = raw.trim();
  const fenceMatch = cleaned.match(/^```(?:json)?\s*([\s\S]*?)```\s*$/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();

  // Extract JSON object if there's surrounding non-JSON text
  if (!cleaned.startsWith("{")) {
    const jsonStart = cleaned.indexOf("{");
    const jsonEnd = cleaned.lastIndexOf("}");
    if (jsonStart !== -1 && jsonEnd !== -1) {
      cleaned = cleaned.slice(jsonStart, jsonEnd + 1);
    }
  }

  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed || typeof parsed !== "object") return null;

    const summary: string = parsed.summary ?? "Generated successfully.";
    const instructions: string | undefined = parsed.instructions;
    const dependencies = parsed.dependencies;

    // ── Incremental update (changedFiles schema) ──────────────────────────
    if (Array.isArray(parsed.changedFiles)) {
      const changedFiles = parsed.changedFiles.filter(isValidFile);
      const deletedFiles: string[] = Array.isArray(parsed.deletedFiles)
        ? parsed.deletedFiles.filter((p: unknown) => typeof p === "string")
        : [];

      // changedFiles must have at least something useful to be valid
      if (changedFiles.length === 0 && deletedFiles.length === 0) return null;

      return {
        summary,
        changedFiles,
        deletedFiles,
        isPartialUpdate: true,
        instructions,
        dependencies,
      };
    }

    // ── Full generation (files schema) ───────────────────────────────────
    if (Array.isArray(parsed.files)) {
      const files = parsed.files.filter(isValidFile);
      if (files.length === 0) return null;

      return {
        summary,
        files,
        isPartialUpdate: false,
        instructions,
        dependencies,
      };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Scans `raw` for every COMPLETE `{...}` object and returns those that look like
 * a `{ path, content }` file. Uses a brace/-string walker (not JSON.parse on the
 * whole thing) so a response truncated mid-file still yields all the files that
 * finished streaming. (F6)
 */
function extractCompleteFileObjects(raw: string): ProjectFile[] {
  const files: ProjectFile[] = [];
  const seen = new Set<string>();
  const n = raw.length;
  let i = 0;

  while (i < n) {
    if (raw[i] !== "{") { i++; continue; }

    // Walk to the matching close brace, respecting string literals + escapes.
    let depth = 0, inStr = false, esc = false, j = i, closed = false;
    for (; j < n; j++) {
      const c = raw[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') {
        inStr = true;
      } else if (c === "{") {
        depth++;
      } else if (c === "}") {
        depth--;
        if (depth === 0) { j++; closed = true; break; }
      }
    }

    if (!closed) {
      // This object is truncated (typically the ROOT object of a response cut
      // off at max_tokens). Complete file objects may still exist INSIDE it —
      // step one char forward and keep scanning rather than giving up.
      i++;
      continue;
    }

    let consumedWholeObject = false;
    try {
      const obj = JSON.parse(raw.slice(i, j));
      if (isValidFile(obj)) {
        // A complete file — record it and skip past its content entirely
        // (never scan inside a file's content string for phantom objects).
        consumedWholeObject = true;
        if (!seen.has(obj.path)) {
          seen.add(obj.path);
          files.push({ path: obj.path, content: obj.content });
        }
      }
      // Parsed but not a file (e.g. an outer container object): fall through
      // and scan inside it for nested file objects.
    } catch { /* balanced but unparseable — scan inside it */ }

    i = consumedWholeObject ? j : i + 1;
  }

  return files;
}

export interface SalvageResult {
  result: GenerationResult;
  /** Number of complete files recovered from the (likely truncated) response. */
  recovered: number;
}

/**
 * Last-resort recovery for a response that failed `parseGenerationResponse`
 * (typically because it was cut off at `max_tokens` mid-JSON). Salvages every
 * complete file object so the user keeps the finished files instead of losing
 * the entire — full-price — generation. Returns null if nothing usable is found.
 */
export function salvageGenerationResponse(raw: string): SalvageResult | null {
  let cleaned = raw.trim();
  const fenceMatch = cleaned.match(/^```(?:json)?\s*([\s\S]*)$/);
  if (fenceMatch) cleaned = fenceMatch[1];

  const files = extractCompleteFileObjects(cleaned);
  if (files.length === 0) return null;

  // Recover the summary if it streamed before the file list.
  const summaryMatch = cleaned.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const summary = summaryMatch
    ? summaryMatch[1].replace(/\\"/g, '"').replace(/\\n/g, "\n")
    : "Generated (partial — the response was cut off).";

  // A truncated existing-project update uses the changedFiles schema.
  const isPartialUpdate =
    /"changedFiles"\s*:/.test(cleaned) && !/"files"\s*:/.test(cleaned);

  return {
    recovered: files.length,
    result: isPartialUpdate
      ? { summary, changedFiles: files, deletedFiles: [], isPartialUpdate: true }
      : { summary, files, isPartialUpdate: false },
  };
}
