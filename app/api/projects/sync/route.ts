import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";
import type { ProjectFile } from "@/lib/types";
import { deriveProjectDir } from "@/lib/project-paths";

export async function POST(req: NextRequest) {
  let body: { projectId: string; projectName: string; files: ProjectFile[]; folderPath?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const { projectId, projectName, files } = body;
  if (!projectId || !projectName || !Array.isArray(files)) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  // Always derive the directory server-side from the id + name — never trust a
  // client-supplied absolute path (which previously allowed writes anywhere on
  // disk). This matches the folder created by /api/projects/folder. (F9)
  const projectDir = deriveProjectDir(projectName, projectId);

  try {
    await fs.mkdir(projectDir, { recursive: true });

    for (const file of files) {
      // Sanitize file path to prevent directory traversal
      const normalizedPath = path.normalize(file.path).replace(/^(\.\.(\/|\\|$))+/, "");
      const filePath = path.join(projectDir, normalizedPath);
      // Ensure the file stays within the project directory (trailing separator
      // guards against a prefix-sibling bypass).
      if (filePath !== projectDir && !filePath.startsWith(projectDir + path.sep)) continue;
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, file.content, "utf-8");
    }

    return NextResponse.json({ success: true, fileCount: files.length, folderPath: projectDir });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
