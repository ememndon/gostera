import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getDiscussSystemPrompt } from "@/lib/framework-prompts";
import { resolveAnthropic, withIdentitySystem, extractRateLimits, describeAnthropicError } from "@/lib/anthropic-client";
import { isGeminiModel, createGeminiStream } from "@/lib/gemini-client";
import { selectFilesForContext } from "@/lib/file-selector";
import type { ProjectFile } from "@/lib/types";

// Shared rate limiter: max 10 req/min per IP
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

const ALLOWED_MODELS = [
  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-20250514",
  "claude-sonnet-4-6",
  "claude-opus-4-8",
];

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

  // Claude credentials are resolved after the model branch — a Gemini discuss
  // must not require Anthropic credentials.
  let body: {
    message: string;
    files?: ProjectFile[];
    history?: { role: "user" | "assistant"; content: string }[];
    model?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { message, files = [], history = [], model } = body;
  if (!message) {
    return NextResponse.json({ error: "Missing message" }, { status: 400 });
  }

  if (message.length > 8000) {
    return NextResponse.json({ error: "Message too long (max 8,000 characters)." }, { status: 400 });
  }

  const systemPrompt = getDiscussSystemPrompt();

  // Send REAL file content (prompt-relevant, budgeted) instead of the first 500
  // chars of every file — otherwise Claude answers confidently about code it
  // never saw. (F10) A moderate budget keeps discuss affordable.
  const DISCUSS_FILE_BUDGET = 60_000;
  const selection = files.length > 0 ? selectFilesForContext(files, message, DISCUSS_FILE_BUDGET) : null;
  const fileContextText =
    selection && selection.selected.length > 0
      ? `Current project files` +
        (selection.wasFiltered
          ? ` (${selection.selected.length} most-relevant of ${files.length} shown):`
          : ` (${selection.selected.length}):`) +
        `\n\n` +
        selection.selected.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n") +
        (selection.omitted.length > 0
          ? `\n\nOther files not shown (ask if relevant): ${selection.omitted.join(", ")}`
          : "")
      : "";

  // ── Gemini branch (free tier) ──────────────────────────────────────────────
  if (isGeminiModel(model)) {
    const gemini = await createGeminiStream({
      model: model!,
      system: systemPrompt,
      history: history.slice(-8),
      userText: fileContextText ? `${fileContextText}\n\nQuestion: ${message}` : message,
      maxTokens: 8_192,
    });
    if (!gemini.ok) {
      return NextResponse.json({ error: gemini.error }, { status: gemini.status });
    }
    const enc = new TextEncoder();
    const geminiReadable = new ReadableStream({
      async start(controller) {
        try {
          for await (const delta of gemini.deltas()) controller.enqueue(enc.encode(delta));
          controller.enqueue(enc.encode(`\n\n__RATELIMIT__${JSON.stringify({
            mode: "gemini",
            limits: {},
            capturedAt: Date.now(),
          })}`));
        } catch (err) {
          controller.error(err);
        } finally {
          controller.close();
        }
      },
    });
    return new NextResponse(geminiReadable, {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Transfer-Encoding": "chunked" },
    });
  }

  // ── Claude branch (default) ────────────────────────────────────────────────
  const auth = resolveAnthropic();
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: 500 });
  }
  const { client, mode } = auth;

  const resolvedModel = ALLOWED_MODELS.includes(model ?? "") ? model! : "claude-sonnet-4-6";

  // File context in its own block with a cache breakpoint so repeated questions
  // on the same project re-read it at the discounted cache rate. (F10)
  const userContent: Anthropic.ContentBlockParam[] = [
    ...(fileContextText
      ? [{ type: "text" as const, text: fileContextText, cache_control: { type: "ephemeral" as const } }]
      : []),
    { type: "text" as const, text: fileContextText ? `Question: ${message}` : message },
  ];

  const messages: Anthropic.MessageParam[] = [
    ...history.slice(-8).map((h) => ({ role: h.role, content: h.content } as Anthropic.MessageParam)),
    { role: "user", content: userContent },
  ];

  // Surface auth/model/rate-limit failures as actionable JSON instead of an
  // opaque 500 (an expired OAuth token previously just showed "Discussion failed").
  let streamResult;
  try {
    streamResult = await client.messages
      .stream({
        model: resolvedModel,
        max_tokens: 8192,
        system: withIdentitySystem(systemPrompt, mode),
        messages,
      })
      .withResponse();
  } catch (err: unknown) {
    const { message, status } = describeAnthropicError(err, mode);
    return NextResponse.json({ error: message }, { status });
  }
  const { data: stream, response } = streamResult;

  const rateLimits = extractRateLimits(response?.headers);

  const encoder = new TextEncoder();

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
