/**
 * Agent tool definitions and executors.
 *
 * Security boundary (honest version):
 * - File tools are confined to the project folder: lexical traversal checks
 *   PLUS realpath resolution, so symlinks inside the project cannot reach
 *   outside it.
 * - run_command spawns WITHOUT a shell (argv built here), rejects shell
 *   metacharacters outright, allowlists executables, restricts git to local
 *   subcommands (no push/pull/fetch/remote/clone), blocks node/python inline
 *   eval flags, and enforces a hard timeout with full process-tree kill.
 * - This is still real code execution as the local user (npm scripts, project
 *   code) — it limits accidents and prompt-injected one-liners, not a hostile
 *   local package. Don't run it on projects you wouldn't run `npm install` on.
 */

import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { spawn } from "child_process";
import type Anthropic from "@anthropic-ai/sdk";

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_FILE_READ_BYTES = 200_000;   // 200 KB per file read
const MAX_COMMAND_OUTPUT_BYTES = 50_000; // 50 KB of command output
const MAX_SEARCH_RESULTS = 50;
const DEFAULT_COMMAND_TIMEOUT_MS = 90_000;
const MAX_COMMAND_TIMEOUT_MS = 180_000;

const ALLOWED_COMMANDS = new Set([
  "npm", "npx", "node", "pip", "pip3", "python", "python3",
  "git", "tsc", "vite", "next",
]);

const IGNORED_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build", "__pycache__",
  ".venv", "venv", ".turbo", "out", "coverage", ".svelte-kit", ".nuxt",
]);

const TEXT_EXTENSIONS = new Set([
  "ts","tsx","js","jsx","mjs","cjs","html","htm","css","scss","sass","less",
  "json","yaml","yml","toml","ini","env","md","mdx","txt","py","rb","php",
  "go","rs","java","kt","c","cpp","h","hpp","sh","bash","zsh","sql",
  "graphql","gql","vue","svelte","xml","svg","prisma","tf","dockerfile",
  "makefile","gitignore","eslintrc","prettierrc","babelrc","lock","conf",
]);

// ─── Tool result type ────────────────────────────────────────────────────────

export interface ToolResult {
  success: boolean;
  output: string;
}

// ─── Security helpers ─────────────────────────────────────────────────────────

function resolveSafe(projectRoot: string, userPath: string): string | null {
  // Real path of the project root (the root itself may be behind a symlink).
  let root = path.resolve(projectRoot);
  try {
    root = fsSync.realpathSync(root);
  } catch { /* root may not exist yet — keep the lexical path */ }

  const resolved = path.resolve(root, userPath);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    return null; // lexical path traversal
  }

  // Symlink hardening: the lexical check above doesn't follow links, so a
  // symlink (or Windows junction) anywhere along the path could point outside
  // the project. Walk up to the deepest ancestor that has a filesystem entry
  // (the target itself may not exist yet for writes), then resolve its REAL
  // path — which follows every symlink in that prefix — and re-check
  // containment against the real root.
  //
  // We use lstatSync (not existsSync) to detect existence: existsSync follows
  // links and returns false for a broken/dangling link, which would let an
  // intermediate escaping symlink slip through as if it were a fresh path.
  let existing = resolved;
  const tail: string[] = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      fsSync.lstatSync(existing); // exists as a real entry OR a (possibly broken) link
      break;
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) break; // reached the filesystem root
      tail.unshift(path.basename(existing));
      existing = parent;
    }
  }

  let real: string;
  try {
    real = fsSync.realpathSync(existing);
  } catch {
    // The deepest existing entry is a dangling/broken link (or otherwise
    // unresolvable) — refuse rather than let fs follow it.
    return null;
  }

  const finalPath = tail.length > 0 ? path.join(real, ...tail) : real;
  if (!finalPath.startsWith(root + path.sep) && finalPath !== root) {
    return null; // symlink escape
  }

  return finalPath;
}

function isTextFile(filePath: string): boolean {
  const name = path.basename(filePath).toLowerCase();
  if (name.startsWith(".") && !name.slice(1).includes(".")) return true;
  const ext = name.split(".").pop() ?? "";
  return TEXT_EXTENSIONS.has(ext);
}

// ─── Directory walker ────────────────────────────────────────────────────────

interface FileEntry {
  path: string;    // relative to project root
  size: number;
  isDirectory: boolean;
}

async function walkDir(
  root: string,
  dir: string,
  results: FileEntry[],
  maxFiles = 500
): Promise<void> {
  let entries: fsSync.Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true }) as fsSync.Dirent[];
  } catch {
    return;
  }

  for (const entry of entries) {
    if (results.length >= maxFiles) break;
    const fullPath = path.join(dir, entry.name);
    const rel = path.relative(root, fullPath).replace(/\\/g, "/");

    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        results.push({ path: rel, size: 0, isDirectory: true });
        await walkDir(root, fullPath, results, maxFiles);
      }
    } else if (entry.isFile()) {
      let size = 0;
      try {
        const stat = await fs.stat(fullPath);
        size = stat.size;
      } catch { /* ignore */ }
      results.push({ path: rel, size, isDirectory: false });
    }
  }
}

// ─── Tool executors ───────────────────────────────────────────────────────────

export async function execGetProjectManifest(projectRoot: string): Promise<ToolResult> {
  const entries: FileEntry[] = [];
  await walkDir(projectRoot, projectRoot, entries, 1000);

  if (entries.length === 0) {
    return { success: true, output: "(empty project — no files yet)" };
  }

  const lines = entries.map((e) => {
    const icon = e.isDirectory ? "📁" : "📄";
    const size = e.isDirectory ? "" : ` (${(e.size / 1024).toFixed(1)}KB)`;
    return `${icon} ${e.path}${size}`;
  });

  const total = entries.filter((e) => !e.isDirectory).length;
  return {
    success: true,
    output: `Project manifest — ${total} files:\n\n${lines.join("\n")}`,
  };
}

export async function execReadFile(
  projectRoot: string,
  input: { path: string }
): Promise<ToolResult> {
  const safe = resolveSafe(projectRoot, input.path);
  if (!safe) return { success: false, output: "Access denied: path outside project root." };

  try {
    const stat = await fs.stat(safe);
    if (stat.isDirectory()) {
      return { success: false, output: `'${input.path}' is a directory. Use list_directory instead.` };
    }
    if (stat.size > MAX_FILE_READ_BYTES) {
      return {
        success: false,
        output: `File is ${(stat.size / 1024).toFixed(0)}KB — too large to read in full (limit: ${MAX_FILE_READ_BYTES / 1024}KB). Use search_files to find specific content.`,
      };
    }
    const content = await fs.readFile(safe, "utf-8");
    return { success: true, output: content };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { success: false, output: `File not found: ${input.path}` };
    }
    return { success: false, output: `Read error: ${msg}` };
  }
}

export async function execWriteFile(
  projectRoot: string,
  input: { path: string; content: string }
): Promise<ToolResult> {
  const safe = resolveSafe(projectRoot, input.path);
  if (!safe) return { success: false, output: "Access denied: path outside project root." };

  try {
    // Create parent directories if needed
    await fs.mkdir(path.dirname(safe), { recursive: true });
    await fs.writeFile(safe, input.content, "utf-8");
    const lines = input.content.split("\n").length;
    return {
      success: true,
      output: `Written: ${input.path} (${lines} lines, ${(input.content.length / 1024).toFixed(1)}KB)`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: `Write error: ${msg}` };
  }
}

export async function execDeleteFile(
  projectRoot: string,
  input: { path: string }
): Promise<ToolResult> {
  const safe = resolveSafe(projectRoot, input.path);
  if (!safe) return { success: false, output: "Access denied: path outside project root." };

  try {
    const stat = await fs.stat(safe);
    if (stat.isDirectory()) {
      await fs.rmdir(safe); // only removes empty dirs
    } else {
      await fs.unlink(safe);
    }
    return { success: true, output: `Deleted: ${input.path}` };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: `Delete error: ${msg}` };
  }
}

export async function execListDirectory(
  projectRoot: string,
  input: { path: string }
): Promise<ToolResult> {
  const safe = resolveSafe(projectRoot, input.path);
  if (!safe) return { success: false, output: "Access denied: path outside project root." };

  try {
    const entries = await fs.readdir(safe, { withFileTypes: true }) as fsSync.Dirent[];
    const lines = entries
      .sort((a, b) => {
        // directories first
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      })
      .map((e) => {
        const icon = e.isDirectory() ? "📁" : "📄";
        const rel = path.join(input.path, e.name).replace(/\\/g, "/");
        return `${icon} ${rel}`;
      });

    return {
      success: true,
      output: lines.length > 0 ? lines.join("\n") : "(empty directory)",
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: `List error: ${msg}` };
  }
}

export async function execSearchFiles(
  projectRoot: string,
  input: { query: string; glob?: string }
): Promise<ToolResult> {
  const query = input.query.toLowerCase();
  const results: string[] = [];
  const entries: FileEntry[] = [];
  await walkDir(projectRoot, projectRoot, entries, 1000);

  const textFiles = entries.filter(
    (e) => !e.isDirectory && isTextFile(e.path)
  );

  // Apply glob filter if provided
  const filtered = input.glob
    ? textFiles.filter((e) => {
        const pattern = input.glob!.replace(/\*/g, ".*").replace(/\?/g, ".");
        return new RegExp(pattern, "i").test(e.path);
      })
    : textFiles;

  for (const entry of filtered) {
    if (results.length >= MAX_SEARCH_RESULTS) break;
    const safe = resolveSafe(projectRoot, entry.path);
    if (!safe) continue;
    try {
      const content = await fs.readFile(safe, "utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(query)) {
          results.push(`${entry.path}:${i + 1}: ${lines[i].trim()}`);
          if (results.length >= MAX_SEARCH_RESULTS) break;
        }
      }
    } catch { /* skip unreadable files */ }
  }

  if (results.length === 0) {
    return { success: true, output: `No matches found for "${input.query}"` };
  }

  const note =
    results.length >= MAX_SEARCH_RESULTS
      ? `\n\n(showing first ${MAX_SEARCH_RESULTS} matches — there may be more)`
      : "";

  return {
    success: true,
    output: `Found ${results.length} match${results.length === 1 ? "" : "es"} for "${input.query}":\n\n${results.join("\n")}${note}`,
  };
}

// ─── run_command security helpers ────────────────────────────────────────────

// Shell metacharacters we refuse outright. Commands are spawned WITHOUT a shell
// (argv is built below), so none of these would be interpreted anyway — but
// rejecting them makes the boundary explicit and blocks chaining/substitution
// smuggling attempts like `npm install && <anything>` or `$(...)` / backticks.
// (`^` and `%` are cmd.exe escape/expansion characters — blocked for the same
// reason on Windows.)
const SHELL_METACHAR_RE = /[&|;<>`$^%\r\n]/;

// git is restricted to LOCAL subcommands — anything that talks to a remote
// (push/pull/fetch/clone/remote/…) is network egress and is blocked.
const GIT_ALLOWED_SUBCOMMANDS = new Set([
  "status", "diff", "log", "add", "commit", "init", "branch", "checkout", "stash",
]);

// On Windows, npm/npx/tsc/vite/next are .cmd shims which Node refuses to spawn
// without a shell (EINVAL, CVE-2024-27980 hardening). We route them through
// their real JS entry points via node.exe instead. Known local-bin entries:
const LOCAL_BIN_ENTRIES: Record<string, string[]> = {
  tsc:  ["node_modules/typescript/bin/tsc"],
  vite: ["node_modules/vite/bin/vite.js"],
  next: ["node_modules/next/dist/bin/next"],
};

/** Split a command string into argv, honouring double-quoted arguments. */
function parseArgv(command: string): string[] | null {
  const args: string[] = [];
  let cur = "";
  let inQuote = false;
  for (const c of command) {
    if (c === '"') { inQuote = !inQuote; continue; }
    if (!inQuote && /\s/.test(c)) {
      if (cur) { args.push(cur); cur = ""; }
      continue;
    }
    cur += c;
  }
  if (inQuote) return null; // unbalanced quote
  if (cur) args.push(cur);
  return args;
}

/** npm-cli.js / npx-cli.js shipped alongside node.exe. */
function findNodeCliScript(name: "npm" | "npx"): string | null {
  const p = path.join(
    path.dirname(process.execPath),
    "node_modules", "npm", "bin", `${name}-cli.js`
  );
  return fsSync.existsSync(p) ? p : null;
}

/** Per-command policy checks. Returns an error message, or null when allowed. */
function validateCommandPolicy(cmd: string, args: string[]): string | null {
  if (cmd === "git") {
    const sub = args[0];
    if (sub === undefined || sub === "--version" || sub === "--help") return null;
    if (sub.startsWith("-")) {
      return `git global options (like '${sub}') are not allowed — start with a subcommand. Allowed subcommands: ${Array.from(GIT_ALLOWED_SUBCOMMANDS).join(", ")}.`;
    }
    if (!GIT_ALLOWED_SUBCOMMANDS.has(sub)) {
      return `git subcommand '${sub}' is blocked — only local git operations are allowed (no network access: push, pull, fetch, clone, remote are all blocked). Allowed subcommands: ${Array.from(GIT_ALLOWED_SUBCOMMANDS).join(", ")}.`;
    }
    return null;
  }

  if (cmd === "node") {
    const banned = args.find(
      (a) => a === "-e" || a === "-p" || a === "--eval" || a === "--print" ||
             a.startsWith("--eval=") || a.startsWith("--print=")
    );
    if (banned) {
      return `'node ${banned}' inline-eval is blocked. Write the code to a project file (e.g. scripts/task.mjs) with write_file, then run 'node scripts/task.mjs'.`;
    }
  }

  if (cmd === "python" || cmd === "python3") {
    if (args.includes("-c")) {
      return `'python -c' inline-eval is blocked. Write the code to a project .py file with write_file, then run that file.`;
    }
  }

  return null;
}

/**
 * Resolve what to actually spawn (no shell). On Windows, .cmd shims are routed
 * through node.exe + their JS entry points; .exe tools (git/python/pip) spawn
 * directly via PATH.
 */
function resolveSpawnTarget(
  cmd: string,
  args: string[],
  projectRoot: string
): { file: string; args: string[] } | { error: string } {
  if (cmd === "node") return { file: process.execPath, args };

  if (process.platform !== "win32") return { file: cmd, args };

  if (cmd === "npm" || cmd === "npx") {
    const cli = findNodeCliScript(cmd);
    if (!cli) return { error: `Could not locate ${cmd}-cli.js next to node.exe — is Node installed normally?` };
    return { file: process.execPath, args: [cli, ...args] };
  }

  if (cmd in LOCAL_BIN_ENTRIES) {
    for (const rel of LOCAL_BIN_ENTRIES[cmd]) {
      const p = path.join(projectRoot, ...rel.split("/"));
      if (fsSync.existsSync(p)) return { file: process.execPath, args: [p, ...args] };
    }
    return {
      error: `'${cmd}' is not installed in this project's node_modules. Run 'npm install' first, or use 'npx ${cmd} ...' instead.`,
    };
  }

  // git / python / pip etc. are real .exe files — spawn directly (PATH lookup).
  return { file: cmd, args };
}

/** Kill the whole process tree — plain SIGKILL leaves grandchildren (npm→node) alive on Windows. */
function killProcessTree(proc: ReturnType<typeof spawn>): void {
  if (process.platform === "win32" && proc.pid) {
    spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    proc.kill("SIGKILL");
  }
}

export async function execRunCommand(
  projectRoot: string,
  input: { command: string; timeout?: number }
): Promise<ToolResult> {
  const raw = input.command.trim();

  // 1. Reject shell metacharacters — no chaining, piping, redirection, or
  //    substitution. One executable + its arguments per call.
  const meta = raw.match(SHELL_METACHAR_RE);
  if (meta) {
    return {
      success: false,
      output:
        `Command rejected: contains the shell metacharacter '${meta[0]}'. ` +
        `Commands run without a shell — chaining (&&, ;, |), redirection (<, >), and substitution ($, \`) are not supported. ` +
        `Run one command per run_command call instead.`,
    };
  }

  // 2. Parse into argv (double quotes group arguments).
  const argv = parseArgv(raw);
  if (!argv || argv.length === 0) {
    return { success: false, output: "Command rejected: empty or has an unbalanced double quote." };
  }

  const cmd = argv[0].toLowerCase();
  const args = argv.slice(1);

  // 3. Executable allowlist.
  if (!ALLOWED_COMMANDS.has(cmd)) {
    return {
      success: false,
      output: `Command '${cmd}' is not allowed.\nAllowed commands: ${Array.from(ALLOWED_COMMANDS).join(", ")}`,
    };
  }

  // 4. Per-command policy (git local-only, no inline eval).
  const policyError = validateCommandPolicy(cmd, args);
  if (policyError) {
    return { success: false, output: `Command rejected: ${policyError}` };
  }

  // 5. Resolve the actual spawn target (handles Windows .cmd shims).
  const target = resolveSpawnTarget(cmd, args, projectRoot);
  if ("error" in target) {
    return { success: false, output: target.error };
  }

  const timeout = Math.min(
    input.timeout ?? DEFAULT_COMMAND_TIMEOUT_MS,
    MAX_COMMAND_TIMEOUT_MS
  );

  return new Promise((resolve) => {
    const proc = spawn(target.file, target.args, {
      cwd: projectRoot,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";

    const appendOutput = (data: Buffer) => {
      output += data.toString();
      // Keep only the last MAX_COMMAND_OUTPUT_BYTES to avoid huge outputs
      if (output.length > MAX_COMMAND_OUTPUT_BYTES) {
        output = `...(output truncated, showing last ${MAX_COMMAND_OUTPUT_BYTES / 1000}KB)...\n` +
          output.slice(output.length - MAX_COMMAND_OUTPUT_BYTES);
      }
    };

    proc.stdout?.on("data", appendOutput);
    proc.stderr?.on("data", appendOutput);

    const timer = setTimeout(() => {
      killProcessTree(proc);
      resolve({
        success: false,
        output: `Command timed out after ${timeout / 1000}s\n\nOutput so far:\n${output}`,
      });
    }, timeout);

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ success: false, output: `Process error: ${err.message}\n${output}` });
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        success: code === 0,
        output: output || `(no output — exit code ${code})`,
      });
    });
  });
}

// ─── Anthropic tool definitions ───────────────────────────────────────────────

export const AGENT_TOOLS: Anthropic.Tool[] = [
  {
    name: "get_project_manifest",
    description:
      "Get a complete tree of all files in the project with their sizes. " +
      "Always call this first to understand the project structure before reading any files.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "read_file",
    description: "Read the full content of a file. Always read a file before modifying it.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Path relative to the project root (e.g. 'src/App.tsx')",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Write complete content to a file — creates the file and any parent directories if they don't exist. " +
      "Always write the COMPLETE file content, not just the changed section.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Path relative to the project root",
        },
        content: {
          type: "string",
          description: "Complete file content to write",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "delete_file",
    description: "Delete a file or empty directory.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Path relative to the project root",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "list_directory",
    description: "List the contents of a directory. Use '.' for the project root.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Directory path relative to the project root",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "search_files",
    description:
      "Search for a string across all project files. Returns matching lines with file path and line number.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "The string to search for (case-insensitive)",
        },
        glob: {
          type: "string",
          description: "Optional glob pattern to filter which files to search (e.g. '*.tsx', 'src/**/*.ts')",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "run_command",
    description:
      "Run a terminal command in the project directory. " +
      "Allowed: npm, npx, node, pip, pip3, python, python3, git, tsc, vite, next. " +
      "Use this to install dependencies, run the build, check for TypeScript errors, etc. " +
      "Restrictions: ONE command per call — no shell chaining/pipes/redirection (&&, ;, |, >, <, $, backticks are rejected); " +
      "git is local-only (status/diff/log/add/commit/init/branch/checkout/stash — push/pull/fetch/clone/remote are blocked); " +
      "inline eval flags (node -e/-p, python -c) are blocked — write code to a file and run the file instead.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: {
          type: "string",
          description: "Full command to run (e.g. 'npm install', 'npm run build', 'npx tsc --noEmit'). Double quotes group arguments.",
        },
        timeout: {
          type: "number",
          description: "Timeout in milliseconds (default 90000, max 180000)",
        },
      },
      required: ["command"],
    },
  },
];

// ─── Tool dispatcher ─────────────────────────────────────────────────────────

export async function executeTool(
  name: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: Record<string, any>,
  projectRoot: string
): Promise<ToolResult> {
  switch (name) {
    case "get_project_manifest":
      return execGetProjectManifest(projectRoot);
    case "read_file":
      return execReadFile(projectRoot, input as { path: string });
    case "write_file":
      return execWriteFile(projectRoot, input as { path: string; content: string });
    case "delete_file":
      return execDeleteFile(projectRoot, input as { path: string });
    case "list_directory":
      return execListDirectory(projectRoot, input as { path: string });
    case "search_files":
      return execSearchFiles(projectRoot, input as { query: string; glob?: string });
    case "run_command":
      return execRunCommand(projectRoot, input as { command: string; timeout?: number });
    default:
      return { success: false, output: `Unknown tool: ${name}` };
  }
}
