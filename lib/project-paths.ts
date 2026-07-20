import path from "path";

/**
 * Single source of truth for the on-disk projects boundary. (F9)
 *
 * All four `/api/projects/*` routes previously re-implemented (or, in the case
 * of `sync`, skipped) the "stay inside the projects root" check. This module
 * centralises it so the boundary is enforced once, the same way everywhere:
 *   - the projects root is always derived server-side,
 *   - client-supplied absolute paths are validated against it (never trusted),
 *   - the containment check uses a trailing separator so a sibling directory
 *     that merely shares a name prefix (e.g. `projects-evil`) can't pass.
 */

export function projectsRoot(): string {
  return path.resolve(process.cwd(), "..", "projects");
}

/** Deterministic folder name for a project — must match across all routes. */
export function safeFolder(name: string, id: string): string {
  const safeName = name
    .replace(/[^a-zA-Z0-9\s-_]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase()
    .slice(0, 40);
  return `${safeName || "project"}-${id.slice(0, 8)}`;
}

/** True when `resolved` is the projects root itself or a descendant of it. */
export function isWithinProjectsRoot(resolved: string): boolean {
  const root = projectsRoot();
  return resolved === root || resolved.startsWith(root + path.sep);
}

/**
 * Derive a project's directory from its id + name — server-side only. The
 * result is inside the projects root by construction. Use this instead of
 * trusting a client-supplied absolute `folderPath`.
 */
export function deriveProjectDir(projectName: string, projectId: string): string {
  return path.join(projectsRoot(), safeFolder(projectName, projectId));
}

/**
 * Cheap, order-independent fingerprint of a file set — the sorted `path:byteLen`
 * list hashed with djb2. Computed the same way from the store (client) and from
 * disk (server) so Generate can detect that an agent (or anything else) changed
 * the folder underneath it before it clobbers those changes. (F2)
 */
export function fingerprintFileSizes(entries: { path: string; size: number }[]): string {
  const joined = entries
    .map((e) => `${e.path}:${e.size}`)
    .sort()
    .join("\n");
  let hash = 5381;
  for (let i = 0; i < joined.length; i++) {
    hash = ((hash << 5) + hash + joined.charCodeAt(i)) | 0;
  }
  return `${entries.length}-${(hash >>> 0).toString(36)}`;
}

type ResolveResult =
  | { ok: true; dir: string }
  | { ok: false; error: string; status: number };

/**
 * Validate a client-supplied `folderPath` against the projects root. For routes
 * that only receive a path (files read-back, install, folder delete). Returns a
 * discriminated result so callers can turn a failure straight into a response.
 */
export function resolveExistingProjectDir(folderPath: string | null | undefined): ResolveResult {
  if (!folderPath) {
    return { ok: false, error: "Missing folderPath", status: 400 };
  }
  const resolved = path.resolve(folderPath);
  if (!isWithinProjectsRoot(resolved)) {
    return { ok: false, error: "Invalid folder path — outside the projects root", status: 403 };
  }
  return { ok: true, dir: resolved };
}
