/**
 * Google Gemini adapter — the first non-Claude provider. (Multi-model support)
 *
 * Uses Gemini's OpenAI-compatible endpoint so this same adapter shape can later
 * serve any OpenAI-compatible provider (Groq, OpenRouter, …) with only a base
 * URL + key change. Plain fetch, no extra SDK dependency.
 *
 * Free tier (as of 2026-07): gemini-3.5-flash — ~15 req/min, 1,500 req/day,
 * 1M context, 64K output, $0. Get a key at https://aistudio.google.com.
 * Env var: GEMINI_API_KEY in .env.local.
 */

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";

/** Model ids routed to this adapter (must match MODEL_OPTIONS in ui-store). */
export const GEMINI_MODELS = new Set(["gemini-3.5-flash"]);

export function isGeminiModel(model: string | undefined | null): boolean {
  return !!model && GEMINI_MODELS.has(model);
}

export function geminiConfigured(): boolean {
  return !!process.env.GEMINI_API_KEY?.trim();
}

export interface GeminiImage {
  data: string; // base64, no data-uri prefix
  mediaType: string;
}

export interface GeminiStreamRequest {
  model: string;
  system: string;
  history: { role: "user" | "assistant"; content: string }[];
  /** The final user turn — text plus optional images (sent as data URIs). */
  userText: string;
  images?: GeminiImage[];
  maxTokens: number;
}

export interface GeminiUsage {
  inputTokens: number;
  outputTokens: number;
  /** "stop" | "length" | … mapped to Anthropic-style stop reasons by callers. */
  finishReason: string | null;
}

export type GeminiStreamResult =
  | {
      ok: true;
      /** Async-iterate for text deltas; usage() is valid only after iteration completes. */
      deltas: () => AsyncGenerator<string, void, unknown>;
      usage: () => GeminiUsage;
    }
  | { ok: false; error: string; status: number };

/** User-facing error messages for Gemini failures (mirrors describeAnthropicError). */
function describeGeminiError(status: number, bodySnippet: string): string {
  if (status === 401 || status === 403) {
    return "Gemini rejected your API key. Check GEMINI_API_KEY in .env.local (get a free key at aistudio.google.com) and restart the dev server.";
  }
  if (status === 429) {
    return "Gemini free-tier rate limit reached (~15 req/min, 1,500/day). Wait a minute and try again, or switch to a Claude model.";
  }
  if (status === 404) {
    return "Gemini model not found — it may have been renamed. Check the model id against aistudio.google.com.";
  }
  return `Gemini API error (${status}): ${bodySnippet}`;
}

// ─── Agent-mode tool calling (OpenAI function-calling format) ────────────────

export interface GeminiToolDef {
  name: string;
  description: string;
  /** JSON schema — Anthropic input_schema passes through unchanged. */
  parameters: unknown;
}

export interface GeminiToolCall {
  id: string;
  name: string;
  /** Raw JSON string as returned by the API — parse with try/catch. */
  arguments: string;
}

/** OpenAI-compatible chat message shapes used by the agent loop. */
export type GeminiChatMessage =
  | { role: "system"; content: string }
  | {
      role: "user";
      content:
        | string
        | ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[];
    }
  | {
      role: "assistant";
      content: string | null;
      /**
       * Echoed VERBATIM from the API response — Gemini 3.x attaches extra
       * fields (e.g. `thought_signature`) to each tool call and rejects the
       * next request with a 400 if they're stripped. Never reconstruct these.
       */
      tool_calls?: unknown[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

export type GeminiCompletionResult =
  | {
      ok: true;
      text: string;
      toolCalls: GeminiToolCall[];
      finishReason: string | null;
      usage: { inputTokens: number; outputTokens: number };
      /** The assistant message to append verbatim before tool results. */
      assistantMessage: GeminiChatMessage;
    }
  | { ok: false; error: string; status: number };

/**
 * One non-streaming chat completion with tool support — one turn of the agent
 * loop (mirrors the Claude loop's per-turn `messages.create`).
 */
export async function geminiAgentCompletion(req: {
  model: string;
  messages: GeminiChatMessage[];
  tools: GeminiToolDef[];
  maxTokens: number;
  signal?: AbortSignal;
}): Promise<GeminiCompletionResult> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) {
    return {
      ok: false,
      status: 500,
      error: "GEMINI_API_KEY is not set. Add it to .env.local (free key from aistudio.google.com) and restart the dev server.",
    };
  }

  let res: Response;
  try {
    res = await fetch(`${GEMINI_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      signal: req.signal,
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxTokens,
        messages: req.messages,
        ...(req.tools.length > 0
          ? {
              tools: req.tools.map((t) => ({
                type: "function" as const,
                function: { name: t.name, description: t.description, parameters: t.parameters },
              })),
            }
          : {}),
      }),
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, status: 499, error: "Request aborted" };
    }
    return {
      ok: false,
      status: 502,
      error: `Could not reach the Gemini API: ${err instanceof Error ? err.message : "network error"}`,
    };
  }

  if (!res.ok) {
    const snippet = (await res.text().catch(() => "")).slice(0, 300);
    return { ok: false, status: res.status, error: describeGeminiError(res.status, snippet) };
  }

  const json = (await res.json()) as {
    choices?: {
      message?: {
        content?: string | null;
        tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
      };
      finish_reason?: string | null;
    }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const choice = json.choices?.[0];
  const msg = choice?.message;

  // Keep the RAW tool-call objects for the echo (Gemini 3.x includes a
  // thought_signature per call and 400s if it's missing on the next request);
  // normalize a parallel view for the loop to execute. If the API omitted an
  // id, inject one into the raw object too so the echoed assistant tool_call
  // id matches the tool-result message's tool_call_id.
  const rawToolCalls = (msg?.tool_calls ?? []) as ({
    id?: string;
    function?: { name?: string; arguments?: string };
  } & Record<string, unknown>)[];

  const toolCalls: GeminiToolCall[] = rawToolCalls.map((tc, i) => {
    if (!tc.id) tc.id = `call_${i}`;
    return {
      id: tc.id,
      name: tc.function?.name ?? "",
      arguments: tc.function?.arguments ?? "{}",
    };
  });

  return {
    ok: true,
    text: msg?.content ?? "",
    toolCalls,
    finishReason: choice?.finish_reason ?? null,
    usage: {
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
    },
    assistantMessage: {
      role: "assistant",
      content: msg?.content ?? null,
      ...(rawToolCalls.length > 0 ? { tool_calls: rawToolCalls } : {}),
    },
  };
}

export async function createGeminiStream(req: GeminiStreamRequest): Promise<GeminiStreamResult> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) {
    return {
      ok: false,
      status: 500,
      error: "GEMINI_API_KEY is not set. Add it to .env.local (free key from aistudio.google.com) and restart the dev server.",
    };
  }

  // Final user turn: images (as data URIs) + text, OpenAI content-parts format.
  const userContent =
    req.images && req.images.length > 0
      ? [
          ...req.images.map((img) => ({
            type: "image_url" as const,
            image_url: { url: `data:${img.mediaType};base64,${img.data}` },
          })),
          { type: "text" as const, text: req.userText },
        ]
      : req.userText;

  const body = {
    model: req.model,
    max_tokens: req.maxTokens,
    stream: true,
    // Ask for a final usage chunk so token counts are real, not estimated.
    stream_options: { include_usage: true },
    messages: [
      { role: "system" as const, content: req.system },
      ...req.history.map((h) => ({ role: h.role, content: h.content })),
      { role: "user" as const, content: userContent },
    ],
  };

  let res: Response;
  try {
    res = await fetch(`${GEMINI_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err: unknown) {
    return {
      ok: false,
      status: 502,
      error: `Could not reach the Gemini API: ${err instanceof Error ? err.message : "network error"}`,
    };
  }

  if (!res.ok || !res.body) {
    const snippet = (await res.text().catch(() => "")).slice(0, 300);
    return { ok: false, status: res.status, error: describeGeminiError(res.status, snippet) };
  }

  const usage: GeminiUsage = { inputTokens: 0, outputTokens: 0, finishReason: null };
  const reader = res.body.getReader();

  async function* deltas(): AsyncGenerator<string, void, unknown> {
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames: lines of `data: {json}` separated by blank lines.
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") continue;
        let chunk: {
          choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        try { chunk = JSON.parse(payload); } catch { continue; }
        if (chunk.usage) {
          usage.inputTokens = chunk.usage.prompt_tokens ?? usage.inputTokens;
          usage.outputTokens = chunk.usage.completion_tokens ?? usage.outputTokens;
        }
        const choice = chunk.choices?.[0];
        if (choice?.finish_reason) usage.finishReason = choice.finish_reason;
        const text = choice?.delta?.content;
        if (text) yield text;
      }
    }
  }

  return { ok: true, deltas, usage: () => usage };
}
