import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { AGENT_TOOLS, executeTool } from "@/lib/agent-tools";
import { resolveAnthropic, withIdentitySystem, extractRateLimits } from "@/lib/anthropic-client";
import {
  isGeminiModel,
  geminiAgentCompletion,
  type GeminiChatMessage,
  type GeminiToolDef,
} from "@/lib/gemini-client";
import type { RateLimits, AuthMode } from "@/lib/rate-limits";
import type { Framework } from "@/lib/types";

// ─── Rate limiting (shared with generate) ────────────────────────────────────

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (entry.count >= 5) return false; // tighter limit for agent — more expensive
  entry.count++;
  return true;
}

// ─── Per-model limits ────────────────────────────────────────────────────────

// Haiku 4.5 / Sonnet 4 support 64K output (previously capped at a stale 8,192).
const MODEL_MAX_TOKENS: Record<string, number> = {
  "claude-haiku-4-5-20251001": 64_000,
  "claude-sonnet-4-20250514":  64_000,
  "claude-sonnet-4-6":         64_000,
  "claude-opus-4-8":           128_000,
};

const ALLOWED_MODELS = Object.keys(MODEL_MAX_TOKENS);
const MAX_AGENT_TURNS = 25;

// Hard ceiling on cumulative output tokens for a single agent run. Turn count
// alone doesn't bound spend — a 25-turn Opus run can emit 128K tokens/turn. This
// caps a runaway run regardless of turns. Overridable per-request via
// `maxRunTokens` (clamped to this value). (F16)
const MAX_RUN_OUTPUT_TOKENS = 400_000;

// ─── Agent event types streamed to the frontend ──────────────────────────────

type AgentEvent =
  | { type: "turn_start";   turn: number }
  | { type: "text";         content: string }
  | { type: "tool_call";    id: string; tool: string; input: Record<string, unknown> }
  | { type: "tool_result";  id: string; tool: string; output: string; success: boolean }
  | { type: "done";         summary: string; turns: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; mode: AuthMode; rateLimits: RateLimits }
  | { type: "error";        message: string };

// ─── Image attachment type (same as generate route) ──────────────────────────

type ImageAttachment = {
  data: string;
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
};

// ─── Agent system prompt ─────────────────────────────────────────────────────

function buildSystemPrompt(framework: Framework | null): string {
  const frameworkNote = framework
    ? `\nThe project uses: ${framework}. Follow its conventions.\n`
    : "";

  return `You are an expert full-stack software engineer with direct access to a real project filesystem on the developer's machine.

You have these tools:
• get_project_manifest — see all project files and sizes (call this FIRST every session)
• read_file — read any file's content
• write_file — create or overwrite a file (always write the COMPLETE file content)
• delete_file — delete a file
• list_directory — list a directory's contents
• search_files — search for a string across all project files
• run_command — run npm, npx, node, pip, python, git, tsc, vite, or next commands
${frameworkNote}
Working rules:
1. Start EVERY task by calling get_project_manifest() to understand the project
2. Always read a file before modifying it — never guess at its current content
3. Make surgical, targeted changes — don't rewrite files you don't need to touch
4. After writing code changes, run the build (npm run build / tsc --noEmit) to verify there are no errors
5. If the build fails, read the error carefully, fix it, and verify again
6. Write complete, production-quality code — no TODOs, no placeholders, no stub implementations
7. Preserve existing code style and conventions
8. Never break existing functionality when adding new features
9. When finished, write a clear summary of every file you changed and why

If an ARCHITECTURE.md or CLAUDE.md exists in the project root, read it first — it contains important context about conventions and decisions already made.`;
}

// ─── Prompt caching helper ────────────────────────────────────────────────────
//
// Marks the last content block of the most recent message with an ephemeral
// cache breakpoint, after clearing any breakpoint left over from a previous
// turn. Combined with the cached system prompt (which, by Anthropic's
// tools → system → messages prefix ordering, also caches the tool definitions),
// this lets each turn re-read the entire prior conversation prefix at the
// ~90%-discounted cache-read rate instead of re-billing it at full input price.
// At most one rolling breakpoint exists in the message list at a time, so we
// never approach Anthropic's 4-breakpoint cap.
function applyMessageCacheBreakpoint(messages: Anthropic.MessageParam[]): void {
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block && typeof block === "object" && "cache_control" in block) {
          delete (block as { cache_control?: unknown }).cache_control;
        }
      }
    }
  }
  const last = messages[messages.length - 1];
  if (last && Array.isArray(last.content) && last.content.length > 0) {
    const lastBlock = last.content[last.content.length - 1];
    if (lastBlock && typeof lastBlock === "object") {
      (lastBlock as { cache_control?: { type: "ephemeral" } }).cache_control = {
        type: "ephemeral",
      };
    }
  }
}

// ─── Main handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const ip =
    req.headers.get("x-forwarded-for") ??
    req.headers.get("x-real-ip") ??
    "unknown";

  if (!checkRateLimit(ip)) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Agent mode allows 5 runs per minute." },
      { status: 429 }
    );
  }

  // Claude credentials are resolved after the model branch — a Gemini agent
  // run must not require Anthropic credentials (and vice versa).
  let body: {
    prompt: string;
    projectPath: string;
    framework?: Framework;
    model?: string;
    history?: { role: "user" | "assistant"; content: string }[];
    maxTurns?: number;
    images?: ImageAttachment[];
    /** Optional per-run output-token cap (clamped to MAX_RUN_OUTPUT_TOKENS). */
    maxRunTokens?: number;
    /** When true, Claude only produces a plan — no tools executed. */
    planOnly?: boolean;
    /** When true, only read-only tools are available — no writes, no commands. */
    discussMode?: boolean;
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const {
    prompt,
    projectPath,
    framework = null,
    model,
    history = [],
    maxTurns = MAX_AGENT_TURNS,
    images = [],
    maxRunTokens,
    planOnly = false,
    discussMode = false,
  } = body;

  const runTokenCap = Math.min(
    typeof maxRunTokens === "number" && maxRunTokens > 0 ? maxRunTokens : MAX_RUN_OUTPUT_TOKENS,
    MAX_RUN_OUTPUT_TOKENS
  );

  if (!prompt) {
    return NextResponse.json({ error: "Missing prompt" }, { status: 400 });
  }

  if (!projectPath) {
    return NextResponse.json(
      { error: "No project folder found. Sync your project to disk first (generate something, then the folder path will be set)." },
      { status: 400 }
    );
  }

  if (prompt.length > 20_000) {
    return NextResponse.json({ error: "Prompt too long (max 20,000 characters)." }, { status: 400 });
  }

  const resolvedModel = ALLOWED_MODELS.includes(model ?? "")
    ? model!
    : isGeminiModel(model)
    ? model!
    : "claude-sonnet-4-6";
  const maxTokens = MODEL_MAX_TOKENS[resolvedModel] ?? 64_000;
  const turnLimit = planOnly ? 1 : Math.min(maxTurns, MAX_AGENT_TURNS);

  // Discuss mode: read-only tools, no writes or commands
  const READ_ONLY_TOOLS = new Set(["get_project_manifest", "read_file", "list_directory", "search_files"]);
  const discussModeAddendum = discussMode
    ? `\n\nDISCUSS MODE ACTIVE: You can read and analyse the project freely, but you MUST NOT write files, delete files, or run any commands. Only use read-only tools: get_project_manifest, read_file, list_directory, search_files. Explain, suggest, and discuss — but make zero changes to the filesystem.`
    : "";

  // Plan-only mode: override system prompt to prevent tool use
  const planOnlyAddendum = planOnly
    ? `\n\nIMPORTANT — PLAN MODE: The user wants to review your plan before you execute anything.
Your ONLY task right now is to produce a numbered action plan describing EXACTLY what you will do:
- Which files you will read
- What changes you will make to which files
- What commands you will run
- What the end result will be

Do NOT call any tools. Do NOT execute anything. Respond with ONLY the numbered plan.
The user will review it and decide whether to proceed.`
    : "";

  const systemPrompt = buildSystemPrompt(framework) + discussModeAddendum + planOnlyAddendum;

  // Tool filtering: plan-only → no tools; discuss → read-only; build → all tools
  // (Anthropic-format list is canonical; the Gemini branch converts it.)
  const tools = planOnly
    ? []
    : discussMode
    ? AGENT_TOOLS.filter((t) => READ_ONLY_TOOLS.has(t.name))
    : AGENT_TOOLS;

  // ── Gemini branch (free tier) ──────────────────────────────────────────────
  // Same tools, same event stream, same abort + token-cap semantics — the loop
  // speaks OpenAI function-calling instead of Anthropic tool_use.
  if (isGeminiModel(resolvedModel)) {
    const gmTools: GeminiToolDef[] = tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      parameters: t.input_schema,
    }));

    const gmMessages: GeminiChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...history.slice(-6).map(
        (h) => ({ role: h.role, content: h.content }) as GeminiChatMessage
      ),
      {
        role: "user",
        content:
          images.length > 0
            ? [
                ...images.map((img) => ({
                  type: "image_url" as const,
                  image_url: { url: `data:${img.mediaType};base64,${img.data}` },
                })),
                { type: "text" as const, text: prompt },
              ]
            : prompt,
      },
    ];

    const geminiStream = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        let aborted = false;
        const enqueue = (event: AgentEvent) => {
          try {
            controller.enqueue(enc.encode(JSON.stringify(event) + "\n"));
          } catch {
            aborted = true; // stream closed — client disconnected
          }
        };
        const onAbort = () => { aborted = true; };
        req.signal.addEventListener("abort", onAbort);

        let totalIn = 0;
        let totalOut = 0;
        let finalSummary = "";
        let rateLimitRetries = 0;

        try {
          for (let turn = 0; turn < turnLimit; turn++) {
            if (aborted || req.signal.aborted) break;

            if (totalOut >= runTokenCap) {
              enqueue({
                type: "error",
                message: `Run stopped: output token cap reached (${totalOut.toLocaleString()} / ${runTokenCap.toLocaleString()}). Start a new, more targeted run to continue.`,
              });
              break;
            }

            enqueue({ type: "turn_start", turn: turn + 1 });

            let result = await geminiAgentCompletion({
              model: resolvedModel,
              messages: gmMessages,
              tools: gmTools,
              maxTokens: 64_000,
              signal: req.signal,
            });

            // Free-tier RPM is ~15/min and an agent loop's quick tool turns can
            // burst past it — wait out 429s (up to 3 per run) instead of dying.
            while (
              !result.ok && result.status === 429 &&
              rateLimitRetries < 3 && !aborted && !req.signal.aborted
            ) {
              rateLimitRetries++;
              enqueue({
                type: "text",
                content: `⏳ Gemini free-tier rate limit — waiting 20s, then continuing (retry ${rateLimitRetries}/3)…`,
              });
              await new Promise((r) => setTimeout(r, 20_000));
              result = await geminiAgentCompletion({
                model: resolvedModel,
                messages: gmMessages,
                tools: gmTools,
                maxTokens: 64_000,
                signal: req.signal,
              });
            }

            if (!result.ok) {
              if (result.status !== 499) enqueue({ type: "error", message: result.error });
              break;
            }

            totalIn += result.usage.inputTokens;
            totalOut += result.usage.outputTokens;

            if (result.text.trim()) {
              enqueue({ type: "text", content: result.text });
              finalSummary = result.text;
            }

            if (result.finishReason === "length") {
              enqueue({
                type: "error",
                message: "Response was cut short — the output token limit was reached. Try a more targeted prompt.",
              });
              break;
            }

            if (result.toolCalls.length === 0) break; // finished normally

            gmMessages.push(result.assistantMessage);

            for (const call of result.toolCalls) {
              if (aborted || req.signal.aborted) break;

              let input: Record<string, unknown> = {};
              try {
                input = call.arguments ? (JSON.parse(call.arguments) as Record<string, unknown>) : {};
              } catch { /* malformed args — executeTool will report the missing fields */ }

              enqueue({ type: "tool_call", id: call.id, tool: call.name, input });
              const toolResult = await executeTool(call.name, input, projectPath);
              enqueue({
                type: "tool_result",
                id: call.id,
                tool: call.name,
                output: toolResult.output,
                success: toolResult.success,
              });
              gmMessages.push({
                role: "tool",
                tool_call_id: call.id,
                // OpenAI format has no is_error flag — prefix instead.
                content: toolResult.success ? toolResult.output : `ERROR: ${toolResult.output}`,
              });
            }
          }

          enqueue({
            type: "done",
            summary: finalSummary,
            turns: gmMessages.filter((m) => m.role === "assistant").length,
            inputTokens: totalIn,
            outputTokens: totalOut,
            cacheReadTokens: 0,
            mode: "gemini",
            rateLimits: {},
          });
        } catch (err: unknown) {
          enqueue({ type: "error", message: err instanceof Error ? err.message : "Unknown error" });
        } finally {
          req.signal.removeEventListener("abort", onAbort);
          controller.close();
        }
      },
    });

    return new NextResponse(geminiStream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Transfer-Encoding": "chunked",
        "X-Agent-Mode": "true",
      },
    });
  }

  // ── Claude branch (default) ────────────────────────────────────────────────
  const auth = resolveAnthropic();
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: 500 });
  }
  const { client, mode } = auth;

  // Prompt caching: cache the system prompt so it (and the tool definitions that
  // precede it in the cache prefix) aren't re-billed at full price on every turn
  // of the agent loop. Ephemeral 5-minute cache, refreshed on each cache hit.
  // In subscription mode the Claude Code identity is prepended as the first
  // (uncached) block — required for OAuth requests.
  const systemBlocks = withIdentitySystem(
    [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
    mode
  ) as Anthropic.TextBlockParam[];

  // Build the first user content block — may include images
  const userContentBlocks: Anthropic.ContentBlockParam[] = [
    ...images.map((img) => ({
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: img.mediaType,
        data: img.data,
      },
    })),
    { type: "text" as const, text: prompt },
  ];

  // Build initial message history
  const messages: Anthropic.MessageParam[] = [
    ...history.slice(-6).map((h) => ({
      role: h.role,
      content: h.content,
    })),
    {
      role: "user" as const,
      content: userContentBlocks,
    },
  ];

  const encoder = new TextEncoder();
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let finalSummary = "";
  let lastRateLimits: RateLimits = {};

  // Helper: send a newline-delimited JSON event
  function makeEventBytes(event: AgentEvent): Uint8Array {
    return encoder.encode(JSON.stringify(event) + "\n");
  }

  const stream = new ReadableStream({
    async start(controller) {
      // Set once the client disconnects (abort signal) or an enqueue fails
      // because the stream is already closed. Either way, the loop must stop
      // calling Claude and executing tools.
      let aborted = false;

      const enqueue = (event: AgentEvent) => {
        try {
          controller.enqueue(makeEventBytes(event));
        } catch {
          // Stream already closed — client disconnected. Signal the loop to stop.
          aborted = true;
        }
      };

      const onAbort = () => { aborted = true; };
      req.signal.addEventListener("abort", onAbort);

      try {
        for (let turn = 0; turn < turnLimit; turn++) {
          if (aborted || req.signal.aborted) break;

          // Per-run output-token ceiling — stop before another expensive turn. (F16)
          if (totalOutputTokens >= runTokenCap) {
            enqueue({
              type: "error",
              message: `Run stopped: output token cap reached (${totalOutputTokens.toLocaleString()} / ${runTokenCap.toLocaleString()}). Start a new, more targeted run to continue.`,
            });
            break;
          }

          enqueue({ type: "turn_start", turn: turn + 1 });

          // ── Call Claude ──────────────────────────────────────────────────
          applyMessageCacheBreakpoint(messages);

          const { data: response, response: httpResponse } = await client.messages
            .create({
              model: resolvedModel,
              max_tokens: maxTokens,
              system: systemBlocks,
              ...(tools.length > 0 ? { tools } : {}),
              messages,
            }, { signal: req.signal })
            .withResponse();

          // Capture the latest rate-limit snapshot (overwritten each turn).
          const turnLimits = extractRateLimits(httpResponse?.headers);
          if (Object.keys(turnLimits).length > 0) lastRateLimits = turnLimits;

          // input_tokens counts only the UNCACHED portion when caching is active.
          // Track cache reads separately so the UI can bill them at the (much
          // cheaper) cache-read rate instead of full input price. Cache-creation
          // tokens are folded into input (billed near the input rate). (F16)
          totalInputTokens +=
            response.usage.input_tokens +
            (response.usage.cache_creation_input_tokens ?? 0);
          totalCacheReadTokens += response.usage.cache_read_input_tokens ?? 0;
          totalOutputTokens += response.usage.output_tokens;

          // ── Stream text blocks ───────────────────────────────────────────
          for (const block of response.content) {
            if (block.type === "text" && block.text.trim()) {
              enqueue({ type: "text", content: block.text });
              finalSummary = block.text; // last text block = summary
            }
          }

          // ── Handle stop reasons ──────────────────────────────────────────
          if (response.stop_reason === "end_turn" || response.stop_reason === "stop_sequence") {
            break;
          }

          if (response.stop_reason === "max_tokens") {
            enqueue({
              type: "error",
              message: "Response was cut short — the output token limit was reached. Try a more targeted prompt or switch to Opus 4.8.",
            });
            break;
          }

          if (response.stop_reason !== "tool_use") {
            enqueue({ type: "error", message: `Unexpected stop reason: ${response.stop_reason}` });
            break;
          }

          // ── Execute tool calls ───────────────────────────────────────────
          const toolUseBlocks = response.content.filter(
            (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
          );

          if (toolUseBlocks.length === 0) break;

          const toolResults: Anthropic.ToolResultBlockParam[] = [];

          for (const toolUse of toolUseBlocks) {
            if (aborted || req.signal.aborted) break;

            const input = toolUse.input as Record<string, unknown>;
            enqueue({ type: "tool_call", id: toolUse.id, tool: toolUse.name, input });

            const result = await executeTool(toolUse.name, input, projectPath);

            enqueue({
              type: "tool_result",
              id: toolUse.id,
              tool: toolUse.name,
              output: result.output,
              success: result.success,
            });

            toolResults.push({
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: result.output,
              is_error: !result.success,
            });
          }

          // Add this turn to message history and continue
          messages.push({ role: "assistant", content: response.content });
          messages.push({ role: "user", content: toolResults });
        }

        enqueue({
          type: "done",
          summary: finalSummary,
          turns: messages.filter((m) => m.role === "assistant").length,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          cacheReadTokens: totalCacheReadTokens,
          mode,
          rateLimits: lastRateLimits,
        });
      } catch (err: unknown) {
        // A client disconnect surfaces as an AbortError — that's expected, not
        // a failure to report.
        const isAbort =
          aborted ||
          req.signal.aborted ||
          (err instanceof Error && err.name === "AbortError");
        if (!isAbort) {
          const message = err instanceof Error ? err.message : "Unknown error";
          enqueue({ type: "error", message });
        }
      } finally {
        req.signal.removeEventListener("abort", onAbort);
        controller.close();
      }
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Transfer-Encoding": "chunked",
      "X-Agent-Mode": "true",
    },
  });
}
