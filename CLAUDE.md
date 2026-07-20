# Gostera — AI App Builder

## What this app is

Gostera is a personal, single-user AI-powered app builder. The user describes what they want to build in plain English, Claude or Gemini generates working code, and the result appears in a live preview. It runs locally as a Next.js 14 app with **no authentication** (localhost only — see Access model below).

To start the dev server:
```
npm run dev
```
Runs at http://localhost:3000 and opens directly.

---

## Tech stack

- **Framework:** Next.js 14 (App Router, TypeScript)
- **AI:** Anthropic Claude API (`@anthropic-ai/sdk`) — streaming responses
- **State:** Zustand with `persist` middleware — project store persists to **IndexedDB** (via `idb-keyval`, see `lib/idb-storage.ts`); UI store persists to localStorage
- **Styling:** Tailwind CSS v3, shadcn/ui components (Radix primitives)
- **Markdown:** `react-markdown` + `remark-gfm`
- **Syntax highlighting:** `highlight.js` with `github-dark` theme
- **ZIP export/import:** `jszip`
- **Auth:** none (single-user, localhost only)
- **GitHub:** OAuth 2.0 + GitHub Git Data API (no extra SDK)

---

## Environment variables (`.env.local`)

```
CLAUDE_CODE_OAUTH_TOKEN=    # Claude subscription token (optional — takes precedence)
ANTHROPIC_API_KEY=          # Claude API key (fallback if no OAuth token)
GEMINI_API_KEY=             # Google Gemini key (free from aistudio.google.com) — enables the Gemini model
GITHUB_CLIENT_ID=           # GitHub OAuth App client ID
GITHUB_CLIENT_SECRET=       # GitHub OAuth App client secret
```

### Claude auth: subscription vs API key

All three Claude routes (`generate`, `discuss`, `agent`) resolve their client
through `lib/anthropic-client.ts`:

- **`CLAUDE_CODE_OAUTH_TOKEN` set** → **subscription mode**. Authenticates with
  `Authorization: Bearer <token>` + `anthropic-beta: oauth-2025-04-20`, and the
  Claude Code identity line is prepended to the system prompt (required for
  OAuth). Usage draws from your Pro/Max subscription rate limits — **no
  per-token billing**. Generate the token once with `claude setup-token`
  (needs Claude Code installed + an active Pro/Max plan; token lasts ~1 year).
- **Only `ANTHROPIC_API_KEY` set** → **api-key mode** (standard metered API).

`withIdentitySystem(system, mode)` prepends the identity block only in
subscription mode. Note: the usage/cost dashboard still computes a dollar
figure from returned token counts, but in subscription mode nothing is actually
billed per-token — treat that number as informational only.

**Credential badge + rate-limit display:**
- `GET /api/status` → `{ mode }` (`subscription` | `api-key` | `none`); no API call.
- `components/auth-badge.tsx` shows a **Subscription / API** badge in the chat
  panel header (fetches `/api/status` on mount), with a hover hint of the top
  token bucket's remaining %/reset; clicking opens the Usage Dashboard.
- All three routes capture Anthropic `anthropic-ratelimit-*` (+ `retry-after`)
  response headers via `extractRateLimits()` and stream them to the client:
  generate/discuss as a `\n\n__RATELIMIT__{json}` trailer (peeled by
  `splitTrailers()` in `lib/parse-response.ts`), agent in its `done` event.
  Stored transiently in `ui-store` (`authMode`, `rateLimits`).
- `lib/rate-limits.ts` (`summarizeRateLimits`) collapses the raw headers into
  per-bucket rows (tokens/requests/unified/…) rendered as progress bars in the
  Usage Dashboard. Header names aren't hardcoded, so subscription `unified-*`
  buckets surface automatically.

**GitHub OAuth callback URL** (must be set in your GitHub OAuth App settings):
`http://localhost:3000/api/github/callback`

---

## Directory structure

```
gostera/
├── app/
│   ├── layout.tsx               # Root layout, imports highlight.js CSS
│   ├── page.tsx                 # Main page (mounts AppLayout)
│   ├── globals.css              # Tailwind base + CSS variables (dark/light theme)
│   └── api/
│       ├── generate/route.ts    # POST — streams Claude code generation
│       ├── discuss/route.ts     # POST — streams Claude discussion mode
│       ├── projects/
│       │   ├── sync/route.ts    # POST — write project files to disk
│       │   └── folder/route.ts  # POST/PATCH/DELETE — manage project folders
│       └── github/
│           ├── auth/route.ts        # GET — redirect to GitHub OAuth
│           ├── callback/route.ts    # GET — exchange code for token
│           ├── user/route.ts        # GET — get connected GitHub user info
│           ├── repos/route.ts       # GET — list user repos
│           ├── push/route.ts        # POST — push project files via Git Data API
│           └── disconnect/route.ts  # DELETE — clear GitHub token cookie
├── components/
│   ├── app-layout.tsx           # Root layout wrapper, mounts all modals
│   ├── sidebar.tsx              # Project list, framework selector, Import button
│   ├── top-bar.tsx              # Project name, tabs, GitHub button, Export, theme
│   ├── chat-panel.tsx           # AI chat, Build/Discuss mode, model picker
│   ├── code-panel.tsx           # File viewer/editor with syntax highlight
│   ├── preview-panel.tsx        # Live iframe preview, device controls
│   ├── welcome-screen.tsx       # First-load screen with quick start + import card
│   ├── github-modal.tsx         # GitHub push modal (connect, configure, push)
│   ├── import-modal.tsx         # Import project from folder/ZIP/drag-and-drop
│   ├── usage-modal.tsx          # Generation usage stats dashboard
│   ├── version-history-modal.tsx # Version restore + line-by-line diff viewer
│   ├── shortcuts-modal.tsx      # Keyboard shortcuts reference
│   ├── small-screen-warning.tsx # Warning overlay for viewports < 1024px
│   └── providers.tsx            # ThemeProvider + TooltipProvider
├── stores/
│   ├── project-store.ts         # Projects, files, chat, versions, generation logs
│   └── ui-store.ts              # UI state, model selection, modals
├── lib/
│   ├── types.ts                 # All TypeScript interfaces
│   ├── project-paths.ts         # Shared projects-root boundary + disk fingerprint helpers
│   ├── framework-prompts.ts     # System prompts for each framework
│   ├── parse-response.ts        # Parse Claude's JSON response + usage trailer
│   ├── export.ts                # Export project as .zip (JSZip)
│   ├── token-estimate.ts        # Token count + cost estimation
│   ├── nanoid.ts                # Simple ID generator
│   └── utils.ts                 # cn() Tailwind class merger
└── hooks/
    └── use-keyboard-shortcuts.ts # Keyboard bindings (Ctrl+B/J/D/E)
```

---

## Supported frameworks

Seven frameworks, each with a dedicated system prompt in `lib/framework-prompts.ts`:

| ID | Label |
|---|---|
| `html-css-js` | HTML / CSS / JS |
| `react-vite` | React + Vite |
| `nextjs` | Next.js 14 |
| `vuejs` | Vue.js 3 |
| `svelte` | Svelte |
| `node-express` | Node.js / Express |
| `python-flask` | Python / Flask |

---

## Available models (multi-provider)

Defined in `stores/ui-store.ts` → `MODEL_OPTIONS` (each entry has a `provider` field). Claude ids are validated server-side via `ALLOWED_MODELS`; Gemini ids via `GEMINI_MODELS` in `lib/gemini-client.ts`.

| ID | Label | Badge | Provider |
|---|---|---|---|
| `claude-haiku-4-5-20251001` | Claude Haiku 4.5 | FAST | claude |
| `claude-sonnet-4-20250514` | Claude Sonnet 4 | BALANCED | claude |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 | RECOMMENDED (default) — 1M context, 64K output | claude |
| `claude-opus-4-8` | Claude Opus 4.8 | MAX — 1M context, 128K output | claude |
| `gemini-3.5-flash` | Gemini 3.5 Flash | FREE — 1M context, 64K output, ~1,500 req/day | gemini |

### Gemini provider (added 2026-07)

`lib/gemini-client.ts` is a fetch-based adapter over Gemini's **OpenAI-compatible endpoint** (`generativelanguage.googleapis.com/v1beta/openai`) — no extra SDK. All three AI routes (generate, discuss, **and agent**) branch on `isGeminiModel(model)` BEFORE resolving Anthropic credentials, so each provider only needs its own key. The generate/discuss branches stream the same text + `__USAGE__`/`__RATELIMIT__` trailers, so the client is provider-agnostic (`finish_reason: "length"` maps to `stop_reason: "max_tokens"` so the truncation-salvage flow works). Cost is $0 (pricing table entry exists so the dashboard shows $0.00). The same adapter shape works for any OpenAI-compatible provider (Groq, OpenRouter) — add base URL + key + model id.

**Agent mode on Gemini:** `geminiAgentCompletion()` runs one OpenAI function-calling turn (the 7 `AGENT_TOOLS` schemas pass through as `parameters`); the agent route has a parallel loop with the same event stream, abort handling, and output-token cap as the Claude loop, plus a 429 wait-and-retry (free tier is ~15 req/min; up to 3×20s waits per run). ⚠️ **Gemini 3.x quirk:** each tool call carries a `thought_signature` that MUST be echoed back verbatim — the adapter passes the RAW `tool_calls` objects through in the assistant echo (reconstructing them from name+arguments causes a 400 on the next turn). OpenAI format has no `is_error` on tool results, so failures are prefixed `ERROR: ` in the tool message content.

---

## Features implemented

### Two generation modes (toggle in chat panel header)

**Generate mode** (single-shot, fast):
- Sends prompt + smart-selected files + last 8 messages → Claude returns JSON → applied to project
- New projects: `{ summary, files[] }` — full file set
- Existing projects: `{ summary, changedFiles[], deletedFiles[] }` — incremental merge
- Smart file selector in `lib/file-selector.ts` stays within a 200K token budget (`FILE_TOKEN_BUDGET`)
- Full Context toggle bypasses the selector (sends all files)

**Agent mode** (tool-use loop, for large/complex projects):
- Claude is given 7 tools: `get_project_manifest`, `read_file`, `write_file`, `delete_file`, `list_directory`, `search_files`, `run_command`
- Claude reads/writes files directly on disk in the project folder — no JSON transport of files
- Loops up to 25 turns autonomously; runs `npm install`, `npm run build`, fixes errors inline
- Streams `AgentEvent` newline-delimited JSON back to the frontend (turn_start, tool_call, tool_result, text, done, error)
- Requires `project.folderPath` to be set (project must have been synced to disk first)
- After agent completes, "Sync" button reads disk → updates Gostera UI via `GET /api/projects/files`
- Agent tools in `lib/agent-tools.ts`; agent loop in `app/api/agent/route.ts`
- Security: path confinement (lexical traversal check + realpath resolution, so in-project symlinks can't escape the root); `run_command` spawns **without a shell** (argv parsed in `agent-tools.ts`), rejects shell metacharacters (`& | ; < > \` $ ^ %`), allowlists executables (npm/npx/node/pip/git/tsc/vite/next), restricts git to local subcommands (status/diff/log/add/commit/init/branch/checkout/stash — push/pull/fetch/clone/remote blocked), blocks inline eval flags (`node -e/-p`, `python -c`), 90s default timeout with full process-tree kill (`taskkill /T /F` on Windows). On Windows, `.cmd` shims (npm/npx/tsc/vite/next) are routed through `node.exe` + their JS entry points since Node refuses to spawn `.cmd` without a shell. Note: this limits accidents and prompt-injected one-liners — running `npm install`/scripts on a project is still real code execution as the local user.
- **Plan-first mode**: toggle in agent panel — Claude produces a numbered plan before executing any tools. User sees "Execute plan" / "Cancel" buttons before anything touches disk.
- **Pre-run snapshot**: before every agent run, `snapshotCurrentFiles()` saves the current state to version history. Restoreable from Version History modal.
- **Running cost meter**: live token + cost display while the agent loop runs
- **File/image upload**: paperclip (text files as code block context) and image button (base64 vision blocks) — same as Generate mode
- **Post-run sync**: "Sync" banner appears after completion → calls `GET /api/projects/files` → updates Gostera UI from disk
- **Preview workflow for non-HTML frameworks**: agent builds project → user runs `npm run dev` in terminal → user clicks "Connect local server" (PlugZap button in preview toolbar) → enters `localhost:{port}` → live preview appears in Gostera
- **Discuss mode** — conversational mode, no code generation, passes full chat history
- **Streaming** — both modes stream text; usage stats appended as `__USAGE__{json}` trailer
- **Abort/cancel** — AbortController wired to a red Stop button while generating
- **Model selection** — per-session model picker in chat panel
- **Prompt length validation** — 12k chars for build, 8k for discuss (server-enforced)
- **Rate limiting** — 10 req/min per IP (in-memory, both API routes)

### Projects
- Create, rename, delete projects (with confirmation)
- Switch between projects — chat history clears per project
- Persistence is automatic on every state change (Zustand `persist` → IndexedDB) — there is no separate timed auto-save
- Disk sync — project files written to `projects/` folder via `/api/projects/sync` (server derives the target dir from the project id — client absolute paths are not trusted)
- Version history — auto-snapshot before each generation, up to 10 versions, restore any version
- **Diff view** — line-by-line `+`/`-` diff between any saved version and current files
- **Export as ZIP** — client-side, uses JSZip

### Chat panel
- Markdown rendering for assistant responses (`react-markdown` + `remark-gfm`)
- Code blocks rendered with distinct styling
- "Recent Changes" file list shown after each build response
- Prompt templates — 5 built-in + custom user templates
- Image attachment — reads as base64, sent to Claude as vision content blocks
- File attachment — pastes file content as code block in the prompt
- Token + cost estimate shown while typing
- Character count warning (yellow) when approaching the limit
- Browser notification when generation finishes (while tab is in background)

### Code panel
- Syntax highlighting via `highlight.js` (language detected from file extension)
- **Edit mode** — pencil button toggles a `<textarea>` for direct editing, Save/Cancel
- **Drag-to-resize** — drag handle at the top of the panel (120–700px height range)
- **In-file search** — `Ctrl+F` opens search bar with match count and prev/next navigation
- File tree on left, code view on right
- Copy and download individual files

### Preview panel
- **HTML/CSS/JS** — full live preview in iframe; CSS and JS files are inlined automatically
- **React + Vite** — CDN-based preview using `unpkg.com` (babel-standalone + React UMD + Tailwind CDN), works for simple component apps
- **Other frameworks** — "Run locally" panel showing the exact install + run commands
- Device preview toggle: mobile (375px), tablet (768px), desktop (full)
- **Open in new tab** — creates a blob URL and opens it (works for HTML and React previews)
- Iframe sandbox: `sandbox="allow-scripts"` (no `allow-same-origin`)
- Refresh button

### Sidebar
- Framework selector (sets the default for new projects)
- Project search — filters by name or framework (appears when >3 projects)
- Per-project context menu: Rename (inline) + Delete (with confirmation)
- **Import button** — opens import modal

### Import feature
Three ways to import an existing project:
1. **Browse Folder** — `showDirectoryPicker()` File System Access API (Chrome/Edge)
2. **Import ZIP** — file input, unpacked with JSZip, root prefix auto-stripped
3. **Drag & Drop** — folder, ZIP, or individual files

What gets filtered out: `node_modules`, `.git`, `.next`, `dist`, `build`, `__pycache__`, `venv`, `.turbo`, `.expo`, `android`, `ios`, binary files, files >300 KB. Cap: 300 files (matches the disk sync-back cap in `/api/projects/files`).

Preview step before import: editable project name, framework selector (auto-detected from `package.json`), scrollable file list with sizes.

Framework auto-detection reads `package.json` deps: `next` → nextjs, `vite+react` → react-vite, `vue` → vuejs, `svelte` → svelte, `express` → node-express. Falls back to python-flask (via `app.py`) or html-css-js.

### GitHub integration
Full OAuth 2.0 flow:
1. Click GitHub icon in top-bar → `/api/github/auth` → redirect to GitHub
2. User authorizes → `/api/github/callback` → token stored in HttpOnly cookie (`gh_token`)
3. Push modal opens showing avatar, username, repo name input, commit message, Public/Private toggle
4. Push via Git Data API: creates repo if needed → blobs (batches of 5) → tree → commit → ref update
5. Success shows commit SHA and "View on GitHub" link

Scopes requested: `repo read:user` (least privilege — `delete_repo` is deliberately not requested)

### Usage dashboard
- Opened via chart icon in chat panel header
- Shows: total generations, total cost, input tokens, output tokens
- Per-framework breakdown with cost
- Last 20 generation logs with prompt preview, cost, date
- Data stored in `generationLogs` in `project-store` (IndexedDB, up to 500 entries)
- Generation logs are saved after every successful build via `addGenerationLog()`

### Access model
- Gostera is designed as a **single-user tool running on your own machine**. There is no login page, no session, and no multi-user concept.
- ⚠️ Every route is therefore directly reachable, including agent mode, which executes commands on the host. **Bind the dev server to localhost only. Put an authenticating layer in front of it before any tunnel, LAN, or deployment exposure.**
- GitHub OAuth (`gh_token` cookie) is a separate concern and only governs the "Push to GitHub" button.

---

## Data persistence

No database backend — persistence is Zustand `persist`:
- `gostera-project` — projects, chat messages, versions, templates, generation logs — persisted to **IndexedDB** (`lib/idb-storage.ts`, `idb-keyval`). No practical size limit.
  - `versions` and `chatMessages` are the *current project's* view; the full per-project history lives in `versionsByProject` / `chatMessagesByProject` maps (and `agentTranscripts` for agent-run memory), so switching projects no longer wipes history.
- `gostera-ui` — sidebar state, selected model, preview device, active tab — persisted to localStorage.

Disk sync failures surface via the store's `syncError` flag (shown in the top bar), not silently swallowed.

---

## What is NOT yet implemented

- Cross-device sync (needs Supabase or real DB)
- Any authentication (single-user by design — localhost only)
- Deploy to Vercel/Netlify
- WebContainers for Node/Python live preview
- Redis-based rate limiting (current is in-memory, resets on restart)
- CSRF tokens (no session to protect)

---

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+B` | Toggle sidebar |
| `Ctrl+J` | Toggle code editor |
| `Ctrl+D` | Toggle Build/Discuss mode |
| `Ctrl+E` | Export as ZIP |
| `Ctrl+F` | Search in file (code panel must be open) |
| `?` | Show shortcuts modal |
| `Esc` | Close modals |

---

## Common tasks for new sessions

**Add a new feature to the UI:** Edit the relevant component in `components/`. Most UI state lives in `ui-store.ts`. Project/data state lives in `project-store.ts`.

**Add a new API route:** Create `app/api/your-route/route.ts`. There is no auth middleware, so every route is directly reachable (localhost only), so validate inputs in the route itself (see `lib/project-paths.ts` for the filesystem boundary helpers).

**Change Claude's behavior for a framework:** Edit the system prompt for that framework in `lib/framework-prompts.ts`.

**Add a new Claude model:** Add it to `MODEL_OPTIONS` in `stores/ui-store.ts` (with `provider: "claude"`) AND to the `ALLOWED_MODELS`/`MODEL_MAX_TOKENS` maps in `app/api/generate/route.ts`, `app/api/discuss/route.ts`, and `app/api/agent/route.ts`, plus `MODEL_PRICING` in `lib/token-estimate.ts` and `MODEL_CONTEXT_LIMITS` in `lib/file-selector.ts`.

**Add a new Gemini (or OpenAI-compatible) model:** Add the id to `GEMINI_MODELS` in `lib/gemini-client.ts` and to `MODEL_OPTIONS` (with `provider: "gemini"`), plus the pricing/context tables above. For a whole new provider, copy the `gemini-client.ts` adapter shape (base URL + key env var).

**Migrate to a real DB (Supabase, etc.):** Persistence is Zustand `persist` over IndexedDB (`lib/idb-storage.ts`). A migration means swapping that storage adapter (and/or moving mutations behind an API), then backfilling from the per-project maps in `stores/project-store.ts` (`versionsByProject`, `chatMessagesByProject`, `agentTranscripts`) — those are already the migration-ready, per-project data shape. (There is no `lib/db.ts` / `DataStore` interface — that was removed as dead scaffolding.)
