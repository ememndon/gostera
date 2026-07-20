import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getSystemPrompt } from "@/lib/framework-prompts";
import { resolveAnthropic, withIdentitySystem, extractRateLimits, describeAnthropicError } from "@/lib/anthropic-client";
import { isGeminiModel, createGeminiStream } from "@/lib/gemini-client";
import type { Framework, ProjectFile } from "@/lib/types";

// Simple in-memory rate limiter: max 10 req/min per IP
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (entry.count >= 10) return false;
  entry.count++;
  return true;
}

// Per-model output token limits.
// Haiku 4.5 supports 64K output (the old 8,192 cap here was the main cause of
// truncated JSON on multi-file generations); Sonnet 4 supports 64K;
// Sonnet 4.6 / Opus 4.8 support 128K (we cap Sonnet 4.6 at 64K deliberately).
const MODEL_MAX_TOKENS: Record<string, number> = {
  "claude-haiku-4-5-20251001": 64_000,
  "claude-sonnet-4-20250514":  64_000,
  "claude-sonnet-4-6":         64_000,
  "claude-opus-4-8":           128_000,
};

const ALLOWED_MODELS = Object.keys(MODEL_MAX_TOKENS);

type ImageAttachment = {
  data: string;
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
};

export async function POST(req: NextRequest) {
  const ip =
    req.headers.get("x-forwarded-for") ??
    req.headers.get("x-real-ip") ??
    "unknown";
  if (!checkRateLimit(ip)) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Max 10 requests per minute." },
      { status: 429 }
    );
  }

  // NOTE: Claude credentials are resolved AFTER the model branch below — a
  // Gemini generation must not require Anthropic credentials (and vice versa).
  let body: {
    prompt: string;
    framework: Framework;
    existingFiles?: ProjectFile[];
    omittedFiles?: string[];       // paths of files excluded due to context budget
    model?: string;
    history?: { role: "user" | "assistant"; content: string }[];
    images?: ImageAttachment[];
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const {
    prompt,
    framework,
    existingFiles = [],
    omittedFiles = [],
    model,
    history = [],
    images = [],
  } = body;

  if (!prompt || !framework) {
    return NextResponse.json({ error: "Missing prompt or framework" }, { status: 400 });
  }

  if (prompt.length > 12000) {
    return NextResponse.json(
      { error: "Prompt too long (max 12,000 characters)." },
      { status: 400 }
    );
  }

  const systemPrompt = getSystemPrompt(framework, existingFiles.length > 0);

  // Prompt caching: cache the system prompt so it isn't re-billed at full price
  // on repeated generations. Ephemeral 5-minute cache, refreshed on each hit.
  const systemBlocks: Anthropic.TextBlockParam[] = [
    { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
  ];

  // Build the file-context (large, and stable across edits) separately from the
  // user's request so the file payload can carry its own cache breakpoint — this
  // lets repeated generations on the same project re-read it at the discounted
  // cache rate instead of re-billing the full file payload each time.
  let fileContextText = "";

  if (existingFiles.length > 0) {
    const allPaths = [
      ...existingFiles.map((f) => f.path),
      ...omittedFiles,
    ].sort();

    const fileContextParts: string[] = [];

    if (omittedFiles.length > 0) {
      fileContextParts.push(
        `IMPORTANT — Full project file list (${allPaths.length} files total):\n` +
        allPaths.map((p) => `  ${p}`).join("\n")
      );
      fileContextParts.push(
        `Files included below (${existingFiles.length} of ${allPaths.length} — ` +
        `the rest were omitted to stay within context limits):\n` +
        `${JSON.stringify(existingFiles, null, 2)}`
      );
      fileContextParts.push(
        `Files NOT included (content unavailable in this request — preserve them unchanged):\n` +
        omittedFiles.map((p) => `  ${p}`).join("\n")
      );
    } else {
      fileContextParts.push(
        `Existing project files:\n${JSON.stringify(existingFiles, null, 2)}`
      );
    }

    fileContextText = fileContextParts.join("\n\n");
  }

  const encoder = new TextEncoder();

  // ── Gemini branch (free tier) ──────────────────────────────────────────────
  // Same system prompt + JSON contract; streams the same text + __USAGE__ /
  // __RATELIMIT__ trailers so the client is provider-agnostic.
  if (isGeminiModel(model)) {
    const gemini = await createGeminiStream({
      model: model!,
      system: systemPrompt,
      history: history.slice(-8),
      userText: fileContextText ? `${fileContextText}\n\nUser request: ${prompt}` : prompt,
      images,
      maxTokens: 64_000,
    });
    if (!gemini.ok) {
      return NextResponse.json({ error: gemini.error }, { status: gemini.status });
    }

    const geminiReadable = new ReadableStream({
      async start(controller) {
        try {
          for await (const delta of gemini.deltas()) {
            controller.enqueue(encoder.encode(delta));
          }
          const u = gemini.usage();
          const usageTrailer = `\n\n__USAGE__${JSON.stringify({
            input_tokens: u.inputTokens,
            output_tokens: u.outputTokens,
            cache_read_tokens: 0,
            stop_reason: u.finishReason === "length" ? "max_tokens" : "end_turn",
          })}`;
          controller.enqueue(encoder.encode(usageTrailer));
          const rlTrailer = `\n\n__RATELIMIT__${JSON.stringify({
            mode: "gemini",
            limits: {},
            capturedAt: Date.now(),
          })}`;
          controller.enqueue(encoder.encode(rlTrailer));
        } catch (err) {
          controller.error(err);
        } finally {
          controller.close();
        }
      },
    });

    return new NextResponse(geminiReadable, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Transfer-Encoding": "chunked",
      },
    });
  }

  // ── Claude branch (default) ────────────────────────────────────────────────
  const auth = resolveAnthropic();
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: 500 });
  }
  const { client, mode } = auth;

  // Build user content — optional images, then (when present) the cached
  // file-context block, then the user's request as the final, uncached block.
  const userContent: Anthropic.ContentBlockParam[] = [
    ...images.map((img) => ({
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: img.mediaType,
        data: img.data,
      },
    })),
    ...(fileContextText
      ? [
          {
            type: "text" as const,
            text: fileContextText,
            cache_control: { type: "ephemeral" as const },
          },
        ]
      : []),
    {
      type: "text" as const,
      text: fileContextText ? `User request: ${prompt}` : prompt,
    },
  ];

  const resolvedModel = ALLOWED_MODELS.includes(model ?? "")
    ? model!
    : "claude-sonnet-4-6";

  const maxTokens = MODEL_MAX_TOKENS[resolvedModel] ?? 8192;

  const historyMessages: Anthropic.MessageParam[] = history
    .slice(-8)
    .map((h) => ({ role: h.role, content: h.content }));

  const messages: Anthropic.MessageParam[] = [
    ...historyMessages,
    { role: "user", content: userContent },
  ];

  // Surface auth/model/rate-limit failures as actionable JSON instead of an
  // opaque 500 (an expired OAuth token previously just showed "Generation failed").
  let streamResult;
  try {
    streamResult = await client.messages
      .stream({
        model: resolvedModel,
        max_tokens: maxTokens,
        system: withIdentitySystem(systemBlocks, mode),
        messages,
      })
      .withResponse();
  } catch (err: unknown) {
    const { message, status } = describeAnthropicError(err, mode);
    return NextResponse.json({ error: message }, { status });
  }
  const { data: stream, response } = streamResult;

  const rateLimits = extractRateLimits(response?.headers);

  const readableStream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of stream) {
          if (
            chunk.type === "content_block_delta" &&
            chunk.delta.type === "text_delta"
          ) {
            controller.enqueue(encoder.encode(chunk.delta.text));
          }
        }
        const finalMessage = await stream.finalMessage();
        // input_tokens counts only the uncached portion when caching is active.
        // Cache-creation tokens are folded into input (billed near the input
        // rate); cache READS are reported separately so the client can bill
        // them at the ~90%-discounted cache-read rate instead of full input
        // price — matching the agent route's accounting. (F16)
        const u = finalMessage.usage;
        const usagePayload = {
          input_tokens:
            u.input_tokens +
            (u.cache_creation_input_tokens ?? 0),
          output_tokens: u.output_tokens,
          cache_read_tokens: u.cache_read_input_tokens ?? 0,
          // Surface truncation so the client can salvage complete files instead
          // of discarding the whole response. (F6)
          stop_reason: finalMessage.stop_reason,
        };
        const usageTrailer = `\n\n__USAGE__${JSON.stringify(usagePayload)}`;
        controller.enqueue(encoder.encode(usageTrailer));

        // Rate-limit trailer (appended LAST — peeled first on the client).
        const rlTrailer = `\n\n__RATELIMIT__${JSON.stringify({
          mode,
          limits: rateLimits,
          capturedAt: Date.now(),
        })}`;
        controller.enqueue(encoder.encode(rlTrailer));
      } catch (err) {
        controller.error(err);
      } finally {
        controller.close();
      }
    },
  });

  return new NextResponse(readableStream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Transfer-Encoding": "chunked",
    },
  });
}
