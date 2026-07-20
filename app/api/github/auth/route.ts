import { NextRequest, NextResponse } from "next/server";

// Note: Next.js route modules may only export route handlers (GET/POST/…) and
// recognised route config — not arbitrary constants — or `next build` fails its
// route type-check. This is module-local (nothing else imports it).
const GITHUB_STATE_COOKIE = "gh_oauth_state";

export async function GET(req: NextRequest) {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ error: "GITHUB_CLIENT_ID not configured" }, { status: 500 });
  }

  // Generate random state for CSRF protection
  const state = crypto.randomUUID();

  const params = new URLSearchParams({
    client_id: clientId,
    // Least privilege: nothing in the codebase deletes repos, so delete_repo is
    // deliberately NOT requested (limits the blast radius of a leaked gh_token).
    scope: "repo read:user",
    state,
    allow_signup: "false",
  });

  const response = NextResponse.redirect(
    `https://github.com/login/oauth/authorize?${params.toString()}`
  );

  // Store state in cookie to verify on callback
  response.cookies.set(GITHUB_STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600, // 10 minutes
    path: "/",
  });

  return response;
}
