import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import { resolveExistingProjectDir } from "@/lib/project-paths";

export async function POST(req: NextRequest) {
  let body: { folderPath: string; framework: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { folderPath, framework } = body;

  // Resolve absolute path and make sure it stays inside the projects directory (F9)
  const resolvedDir = resolveExistingProjectDir(folderPath);
  if (!resolvedDir.ok) {
    return NextResponse.json({ error: resolvedDir.error }, { status: resolvedDir.status });
  }
  const resolved = resolvedDir.dir;

  const isPython = framework === "python-flask";
  const command = isPython ? "pip" : "npm";
  const args = isPython ? ["install", "-r", "requirements.txt"] : ["install"];

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const proc = spawn(command, args, {
        cwd: resolved,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const push = (chunk: Buffer) => {
        controller.enqueue(encoder.encode(chunk.toString()));
      };

      proc.stdout?.on("data", push);
      proc.stderr?.on("data", push);

      proc.on("error", (err) => {
        controller.enqueue(encoder.encode(`\nError: ${err.message}`));
        controller.close();
      });

      proc.on("close", (code) => {
        controller.enqueue(
          encoder.encode(`\n\n__INSTALL_DONE__${JSON.stringify({ code })}`)
        );
        controller.close();
      });
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Transfer-Encoding": "chunked",
    },
  });
}
