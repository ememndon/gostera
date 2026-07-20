import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { resolveExistingProjectDir, fingerprintFileSizes } from "@/lib/project-paths";

// Must mirror the ignore/text rules used by /api/projects/files so the disk
// fingerprint covers the same files the store round-trips. (F2)
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
// MUST equal /api/projects/files' MAX_FILES: that route stops reading at 300
// files, so an uncapped fingerprint over a >300-file project would never match
// the store's view — a permanent staleness false positive. (L2)
const MAX_FILES = 300;

// MUST stay mirrored with /api/projects/files. Without this, .gostera.json
// (written into every project folder by /api/projects/folder) exists on disk
// but never in the store — so the staleness fingerprint mismatched on EVERY
// generation and the "disk has changed" dialog fired as a permanent false
// positive.
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

async function collect(
  root: string,
  dir: string,
  out: { path: string; size: number }[]
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) break;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) await collect(root, full, out);
    } else if (entry.isFile() && isTextFile(entry.name)) {
      try {
        const stat = await fs.stat(full);
        if (stat.size > MAX_FILE_BYTES) continue;
        // Byte length of the UTF-8 content — matches the client's TextEncoder count.
        const content = await fs.readFile(full, "utf-8");
        const rel = path.relative(root, full).replace(/\\/g, "/");
        out.push({ path: rel, size: Buffer.byteLength(content, "utf-8") });
      } catch { /* skip unreadable */ }
    }
  }
}

/**
 * GET /api/projects/fingerprint?folderPath=...
 * Returns a cheap fingerprint of the project's on-disk file set so the client
 * can tell whether the disk moved since it last synced.
 */
export async function GET(req: NextRequest) {
  const folderPath = req.nextUrl.searchParams.get("folderPath");
  const resolvedDir = resolveExistingProjectDir(folderPath);
  if (!resolvedDir.ok) {
    return NextResponse.json({ error: resolvedDir.error }, { status: resolvedDir.status });
  }

  try {
    await fs.access(resolvedDir.dir);
  } catch {
    // No folder on disk yet — nothing to be stale against.
    return NextResponse.json({ fingerprint: null, exists: false });
  }

  const files: { path: string; size: number }[] = [];
  await collect(resolvedDir.dir, resolvedDir.dir, files);
  return NextResponse.json({ fingerprint: fingerprintFileSizes(files), exists: true, count: files.length });
}
