import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";
import { safeFolder, projectsRoot, resolveExistingProjectDir } from "@/lib/project-paths";

// POST — create a new project folder
export async function POST(req: NextRequest) {
  let body: { projectId: string; projectName: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const { projectId, projectName } = body;
  if (!projectId || !projectName) {
    return NextResponse.json({ error: "Missing projectId or projectName" }, { status: 400 });
  }

  const folderName = safeFolder(projectName, projectId);
  const projectDir = path.join(projectsRoot(), folderName);

  try {
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      path.join(projectDir, ".gostera.json"),
      JSON.stringify({ projectId, projectName, createdAt: new Date().toISOString() }, null, 2),
      "utf-8"
    );
    return NextResponse.json({ folderPath: projectDir, folderName });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// PATCH — rename an existing project folder
export async function PATCH(req: NextRequest) {
  let body: { projectId: string; projectName: string; oldFolderPath?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const { projectId, projectName, oldFolderPath } = body;
  if (!projectId || !projectName) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const newFolderName = safeFolder(projectName, projectId);
  const newFolderPath = path.join(projectsRoot(), newFolderName);

  try {
    // If we have the old path and it exists, rename it. Validate it against
    // the projects root first — a client-supplied absolute path must never be
    // able to fs.rename() an arbitrary directory into the projects root. (F9)
    const oldDir = oldFolderPath ? resolveExistingProjectDir(oldFolderPath) : null;
    if (oldDir?.ok) {
      try {
        await fs.access(oldDir.dir);
        if (oldDir.dir !== newFolderPath) {
          await fs.rename(oldDir.dir, newFolderPath);
        }
      } catch {
        // Old folder doesn't exist — just create the new one
        await fs.mkdir(newFolderPath, { recursive: true });
      }
    } else {
      await fs.mkdir(newFolderPath, { recursive: true });
    }

    // Update .gostera.json with new name
    await fs.writeFile(
      path.join(newFolderPath, ".gostera.json"),
      JSON.stringify({ projectId, projectName, updatedAt: new Date().toISOString() }, null, 2),
      "utf-8"
    );

    return NextResponse.json({ folderPath: newFolderPath, folderName: newFolderName });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// DELETE — remove a project folder from disk
export async function DELETE(req: NextRequest) {
  let body: { folderPath?: string; projectId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const { folderPath } = body;
  // Safety: only allow deleting paths inside the projects root (F9)
  const resolvedDir = resolveExistingProjectDir(folderPath);
  if (!resolvedDir.ok) {
    return NextResponse.json({ error: resolvedDir.error }, { status: resolvedDir.status });
  }

  try {
    await fs.rm(resolvedDir.dir, { recursive: true, force: true });
    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
