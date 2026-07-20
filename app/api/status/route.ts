import { NextResponse } from "next/server";
import { currentAuthMode } from "@/lib/anthropic-client";

/**
 * Lightweight status probe for the UI — reports which Claude credential is
 * active so the chat panel can show a Subscription / API badge on load.
 * Does NOT make any Anthropic API call.
 */
export async function GET() {
  return NextResponse.json({ mode: currentAuthMode() });
}
