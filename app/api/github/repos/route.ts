import { NextRequest, NextResponse } from "next/server";

const GITHUB_COOKIE = "gh_token";

export async function GET(req: NextRequest) {
  const token = req.cookies.get(GITHUB_COOKIE)?.value;
  if (!token) {
    return NextResponse.json({ error: "Not connected to GitHub" }, { status: 401 });
  }

  const res = await fetch(
    "https://api.github.com/user/repos?sort=updated&per_page=50&affiliation=owner",
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  );

  if (!res.ok) {
    return NextResponse.json({ error: "GitHub API error" }, { status: res.status });
  }

  const repos = await res.json() as { name: string; full_name: string; private: boolean; html_url: string }[];
  return NextResponse.json(repos.map((r) => ({
    name: r.name,
    fullName: r.full_name,
    private: r.private,
    url: r.html_url,
  })));
}
