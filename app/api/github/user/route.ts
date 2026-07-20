import { NextRequest, NextResponse } from "next/server";

const GITHUB_COOKIE = "gh_token";

export async function GET(req: NextRequest) {
  const token = req.cookies.get(GITHUB_COOKIE)?.value;
  if (!token) {
    return NextResponse.json({ connected: false }, { status: 200 });
  }

  const res = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!res.ok) {
    // Token is invalid or revoked
    const response = NextResponse.json({ connected: false }, { status: 200 });
    response.cookies.delete(GITHUB_COOKIE);
    return response;
  }

  const user = await res.json() as { login: string; avatar_url: string; name: string | null };
  return NextResponse.json({
    connected: true,
    login: user.login,
    name: user.name,
    avatar_url: user.avatar_url,
  });
}
