import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import type { ProjectFile } from "@/lib/types";
import { resolveExistingProjectDir } from "@/lib/project-paths";

const IGNORED_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build", "__pycache__",
  ".venv", "venv", ".turbo", "out", "coverage", ".svelte-kit", ".nuxt",
]);

const TEXT_EXTENSIONS = new Set([
  "ts","tsx","js","jsx","mjs","cjs","html","htm","css","scss","sass","less",
  "json","yaml","yml","toml","ini","env","md","mdx","txt","py","rb","php",
  "go","rs","java","kt","c","cpp","h","hpp","sh","bash","zsh","sql",
  "graphql","gql","vue","svelte","xml","svg","prisma","tf","dockerfile",
  "lock","conf","gitignore","eslintrc","prettierrc","babelrc",
]);

const MAX_FILE_BYTES = 500_000;
const MAX_FILES = 300;

// Never round-trip these into the project file set: .gostera.json is Gostera's
// own folder metadata (not project source), and lockfiles are excluded on
// import too — pulling them in makes the store diverge from what the user
// actually manages (and pollutes Claude context / GitHub pushes / exports).
// MUST stay mirrored with /api/projects/fingerprint.
const IGNORED_FILES = new Set([
  ".gostera.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
  ".ds_store", "thumbs.db",
]);

function isTextFile(filePath: string): boolean {
  const name = path.basename(filePath).toLowerCase();
  if (IGNORED_FILES.has(name)) return false;
  if (name.startsWith(".") && !name.slice(1).includes(".")) return true;
  const ext = name.split(".").pop() ?? "";
  return TEXT_EXTENSIONS.has(ext);
}

async function readDirRecursive(
  root: string,
  dir: string,
  files: ProjectFile[]
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (files.length >= MAX_FILES) break;
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        await readDirRecursive(root, fullPath, files);
      }
    } else if (entry.isFile() && isTextFile(entry.name)) {
      try {
        const stat = await fs.stat(fullPath);
        if (stat.size > MAX_FILE_BYTES) continue;
        const content = await fs.readFile(fullPath, "utf-8");
        const rel = path.relative(root, fullPath).replace(/\\/g, "/");
        files.push({ path: rel, content });
      } catch { /* skip unreadable */ }
    }
  }
}

/**
 * GET /api/projects/files?folderPath=...
 *
 * Reads all source files from a project folder on disk and returns them
 * as ProjectFile[]. Called after an agent run completes to sync the
 * Gostera UI with what the agent actually wrote to disk.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const folderPath = searchParams.get("folderPath");

  // Resolve and validate — must stay inside the projects directory (F9)
  const resolvedDir = resolveExistingProjectDir(folderPath);
  if (!resolvedDir.ok) {
    return NextResponse.json({ error: resolvedDir.error }, { status: resolvedDir.status });
  }
  const resolved = resolvedDir.dir;

  try {
    await fs.access(resolved);
  } catch {
    return NextResponse.json({ error: "Folder not found" }, { status: 404 });
  }

  const files: ProjectFile[] = [];
  await readDirRecursive(resolved, resolved, files);

  // Surface hitting the cap — silent truncation reads as "loaded everything". (L2)
  const truncated = files.length >= MAX_FILES;
  return NextResponse.json({ files, count: files.length, truncated });
}
