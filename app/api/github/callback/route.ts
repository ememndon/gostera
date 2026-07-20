import { NextRequest, NextResponse } from "next/server";

const GITHUB_COOKIE = "gh_token";
const GITHUB_STATE_COOKIE = "gh_oauth_state";

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const savedState = req.cookies.get(GITHUB_STATE_COOKIE)?.value;

  // Validate state to prevent CSRF
  if (!state || !savedState || state !== savedState) {
    return NextResponse.redirect(new URL("/?github=error&reason=state_mismatch", req.url));
  }

  if (!code) {
    return NextResponse.redirect(new URL("/?github=error&reason=no_code", req.url));
  }

  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return NextResponse.redirect(new URL("/?github=error&reason=not_configured", req.url));
  }

  // Exchange code for access token
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  });

  const tokenData = await tokenRes.json() as { access_token?: string; error?: string };

  if (!tokenData.access_token) {
    return NextResponse.redirect(new URL("/?github=error&reason=token_exchange_failed", req.url));
  }

  const response = NextResponse.redirect(new URL("/?github=connected", req.url));

  // Store token in HttpOnly cookie
  response.cookies.set(GITHUB_COOKIE, tokenData.access_token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365, // 1 year (GitHub tokens don't expire)
    path: "/",
  });

  // Clear the state cookie
  response.cookies.delete(GITHUB_STATE_COOKIE);

  return response;
}
