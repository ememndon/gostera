import { NextResponse } from "next/server";

const GITHUB_COOKIE = "gh_token";

export async function DELETE() {
  const response = NextResponse.json({ success: true });
  response.cookies.delete(GITHUB_COOKIE);
  return response;
}
