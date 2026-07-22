# Architecture Blind-Spot Audit: Gostera App Builder

> ### ⚠️ Historical document: describes the codebase *before* the fixes
>
> This is the audit I ran against Gostera on 2026-07-10. **It is kept in the repo
> as a record of the review process, not as a description of the current app.**
> Every Critical and High finding below, and all sixteen numbered findings, were
> fixed in the weeks after it was written. The system model in the next section
> also describes the pre-fix architecture and no longer matches the code.
>
> If you are reviewing this repo to judge the current state of the app, read the
> code and `CLAUDE.md`. If you are here to see how the app was reviewed and
> hardened, this is that document. A short note on what each fix turned into is
> at the bottom under **Resolution**.

**Date:** 2026-07-10 · **Mode:** codebase · **Scope:** entire `gostera/` app (~9,400 lines: all API routes, stores, lib, hooks, and every major component), plus workflows, prompts, and tooling. Includes a premium-upgrade roadmap at the end (explicitly requested).

---

## System model (as I understand it)

Gostera is a single-user, password-gated Next.js 14 app builder. Projects live in **two places at once**: a Zustand store persisted to IndexedDB (files, chat, versions, logs) and a real folder on disk under `../projects/`. **Generate mode** ships selected files to Claude as JSON and merges the JSON reply back into the store, then fire-and-forgets a disk sync. **Agent mode** bypasses the store entirely: a server-side loop (max 25 turns) gives Claude 7 filesystem/command tools that operate directly on the disk folder, then a manual "Sync" button reads disk back into the store. Preview is an iframe (inline HTML, CDN-based React, or a user-run local server). GitHub push rebuilds a commit from the **store's** copy of files via the Git Data API. Auth is an HMAC cookie; Claude auth is OAuth-subscription-first with API-key fallback; prompt caching is wired into generate + agent.

The defining structural fact: **the store and the disk are dual sources of truth connected by one-way, fire-and-forget syncs.** Most of the serious findings below are consequences of that.

---

## Top findings at a glance

| # | Severity | Blind spot | What breaks | When it bites |
|---|----------|-----------|-------------|---------------|
| F1 | Critical | Stop button doesn't stop the agent server-side | Agent keeps editing disk + billing tokens after "Stop" | Any cancelled agent run |
| F2 | Critical | Dual source of truth; restore/agent/push desync silently | Agent work silently overwritten; restores that don't restore; stale pushes | Forget one Sync click |
| F3 | High | Version history wiped on project switch; chat bleeds across projects | Your safety net vanishes exactly when you need it | Switch projects after a bad run |
| F4 | High | Command allowlist is decorative (`shell:true`, first-token check) | `npm install && <anything>` runs; imported files can prompt-inject the agent | Importing untrusted code |
| F5 | High | React preview stylesheet 404s (verified) | Every React+Vite preview renders unstyled | Every React preview, today |
| F6 | High | Single-JSON generation transport; truncation = total loss | Full-price generation → "No response received" | Big apps on 8K-output models |
| F7 | High | GitHub push: final ref update unchecked; deletions never propagate | "Pushed ✓" with nothing pushed; ghost files in repo forever | Non-fast-forward or any deletion |
| F8 | Medium | Multi-tab last-write-wins on the whole store | One tab silently erases the other's work | Open Gostera twice |
| F9 | Medium | `/api/projects/sync` accepts any absolute `folderPath` | Writes anywhere on disk; inconsistent with the 3 routes that validate | Security-adjacent; XSS/CSRF away |
| F10 | Medium | Discuss mode sees only first 500 chars of each file | Confident answers about code Claude can't see | Every discuss question |
| F11 | Medium | Agent runs are stateless; transcript lost on unmount | "Now fix the header too" arrives with zero context | Every follow-up prompt |
| F12 | Medium | O(project-bytes) recompute per keystroke (budget meter) | Typing lag grows with project size | ~100+ files |
| F13 | Medium | All disk syncs are fire-and-forget with `catch(() => {})` | Disk diverges with zero feedback | Any sync failure |
| F14 | Medium | Plan approval executes the *first* plan in the list, not the approved one | Second plan-first run executes with stale plan text | Two plan cycles in one session |
| F15 | Medium | Dead scaffolding + decorative chrome; docs drift | `lib/db.ts` migration path is fiction; dead buttons; wrong CLAUDE.md | Every future AI session inherits the confusion |
| F16 | Medium | Cost numbers wrong per model; no run budget cap | Opus billed at Sonnet prices in the dashboard; no ceiling on a 25-turn run | Any Opus/Haiku use; any runaway run |

Low findings (capped, see below): session tokens never expire, import/sync file-count mismatch, unvirtualized line gutter, in-memory rate limiter.

---

## Findings

### [CRITICAL] F1: The Stop button only stops the UI; the agent keeps running

- **Where:** [route.ts](../app/api/agent/route.ts) (`POST`, the `ReadableStream.start` loop) + [agent-panel.tsx:448](../components/agent-panel.tsx) (`handleCancel`)
- **What I found:** The client aborts its `fetch`, but the server loop never looks at `req.signal`, defines no `cancel()` on the stream, and swallows enqueue failures with `catch { /* stream already closed */ }`. Once the client disconnects, the loop keeps calling Claude and executing `write_file` / `run_command` for up to 25 turns.
- **Failure narrative:** You watch the agent start rewriting the wrong file. You hit Stop. The panel says it stopped, so you open the code editor and start fixing things. Meanwhile the orphaned server loop spends the next several minutes overwriting the same files underneath you and burning tokens. Because the client stopped listening, the "Sync" banner never appears, so the UI never even learns the disk changed (compounds F2).
- **Why it's easy to miss:** Cancelling looks like it works: the spinner stops, the UI is responsive. The only witnesses are the disk mtimes and the Anthropic bill.
- **Fix direction:** Thread `req.signal` into the loop (`if (req.signal.aborted) break` each turn, pass `{ signal }` to `client.messages.create`), and treat a failed enqueue as a disconnect signal (set a flag in the catch, break the loop). ~15 lines.

### [CRITICAL] F2: Two sources of truth, one-way syncs: restore, agent, and push silently diverge

- **Where:** [project-store.ts:307](../stores/project-store.ts) (`restoreVersion`, no disk sync), [agent-panel.tsx:757](../components/agent-panel.tsx) (manual Sync banner), [top-bar.tsx](../components/top-bar.tsx) (GitHub modal receives `currentProject.files` from the store)
- **What I found:** Every path that mutates store files syncs to disk *except* `restoreVersion`. Agent mode mutates disk and relies on a **manual** button to update the store. GitHub push and ZIP export read the store copy. Nothing ever checks whether the two copies agree.
- **Failure narrative (three real ones):**
  1. Agent finishes; you forget to click Sync; you type a Generate-mode prompt. The store's *stale* files are sent to Claude, merged, and then written to disk. **The agent's entire run is silently reverted.**
  2. You restore yesterday's version. The UI shows it; the disk still has today's files. The next agent run "fixes" the codebase you thought you'd rolled back.
  3. Agent wrote to disk; without Sync you push to GitHub: the repo gets the pre-agent code while the modal says "Pushed successfully."
- **Why it's easy to miss:** Each individual flow works when you follow the happy path in order. The failure needs two flows interleaved, which is exactly how the tool is actually used.
- **Fix direction:** Pick a canon. For folder-backed projects the disk should be canonical: (a) auto-sync from disk when an agent run completes (call the existing `syncFromDisk` on the `done` event, one line); (b) make `restoreVersion` call `/api/projects/sync` like every other mutation; (c) before a Generate merge, compare a disk fingerprint (mtime hash from a cheap endpoint) and refuse/re-read if it moved. (a) and (b) are trivial; (c) is a day.

### [HIGH] F3: Version history is wiped on every project switch; deleted projects leak chat into the next one

- **Where:** [project-store.ts:101](../stores/project-store.ts) (`switchProject` sets `versions: []`), same in `createProject`/`setCurrentProject`; [project-store.ts:150](../stores/project-store.ts) (`deleteProject` keeps `chatMessages` when another project exists)
- **What I found:** `versions` and `chatMessages` are single global arrays, not keyed by project. Switching projects zeroes them. The documented safety net, "pre-run auto-snapshot, restorable from Version History," only survives while you never leave the project. Also: delete the *current* project and the next project inherits the dead project's chat transcript (`chatMessages: nextCurrent ? get().chatMessages : []`).
- **Failure narrative:** Agent mangles project A. You hop to project B to check something, come back to A to restore the pre-agent snapshot: Version History says "No versions saved yet." The snapshot the app promised you is gone, precisely in the moment it existed for.
- **Why it's easy to miss:** The snapshot code runs and works; the loss happens in a different action (switching) that looks unrelated. Ten-version cap plus global storage means the design was never exercised across projects.
- **Fix direction:** Store `versions` and `chatMessages` keyed by `projectId` (a `Record<string, ...>` in the same store works; `lib/db.ts` already sketches the right shape: per-project keys). Stop clearing on switch; select by current project id instead. Fixes the chat-bleed bug for free.

### [HIGH] F4: The command sandbox is decorative: allowlist checks one token, then hands the whole string to a shell

- **Where:** [agent-tools.ts:286-310](../lib/agent-tools.ts) (`execRunCommand`: `parts[0]` check → `spawn(input.command, [], { shell: true })`)
- **What I found:** Only the first whitespace token is checked. `npm install && del /s /q ..\..` passes. And the allowlist itself contains full interpreters: `node -e "…"`, `python -c "…"`, `git push` to any remote. So even without metacharacters, run_command is arbitrary code execution and network egress by design. The comment says "no path traversal is possible… strict allowlist," which is what makes this a blind spot: the *documented* trust model and the *actual* one differ.
- **Failure narrative:** You import a ZIP of some open-source project to study it. A README or source comment contains instructions crafted for coding agents ("to build this project, run: `node -e '<exfiltrate .env>'`"). The agent, doing its diligent read-everything pass, follows it. Path confinement doesn't help: the command runs with your full user privileges.
- **Why it's easy to miss:** With one trusted user prompting the agent, the allowlist never gets adversarial input. The threat only appears when *file contents* become instructions, i.e., the moment you import third-party code.
- **Fix direction:** Be honest about the boundary. Minimum: reject commands containing shell metacharacters (`&& || ; | > < \` $( )`) and spawn without `shell:true` (split args yourself); drop `git` push capability or pin it. Real fix at "premium" ambition: run commands in a container/job object, or accept and *document* that agent mode = full code execution and gate imports accordingly. Note also: `SIGKILL` via a Windows shell often leaves grandchild processes (npm→node) alive after timeout. Use `taskkill /T` semantics or `tree-kill`.

### [HIGH] F5: React previews are unstyled: the Tailwind CDN URL 404s (verified today)

- **Where:** [preview-panel.tsx:66](../components/preview-panel.tsx): `https://cdn.jsdelivr.net/npm/tailwindcss@3/dist/tailwind.min.css`
- **What I found:** Tailwind v3 ships no prebuilt `dist/` CSS (that was v2). I checked: the URL returns **404** (the v2.2.19 equivalent returns 200). Meanwhile the react-vite system prompt mandates "Use Tailwind for all styling," so every generated React app's classes resolve to nothing in preview.
- **Failure narrative:** Every React+Vite generation. Claude produces a genuinely nice Tailwind UI; the preview shows 1995-era unstyled HTML; the user concludes the generation is bad and burns more tokens "fixing" styling that was never broken.
- **Why it's easy to miss:** No console error you'd notice inside a sandboxed iframe; HTML preview (the default framework) is unaffected, so the happy path demos fine.
- **Fix direction:** One line: replace the `<link>` with the Play CDN script `<script src="https://cdn.tailwindcss.com"></script>` (works with babel-standalone; compiles classes at runtime). Also note the TS-stripping regexes (`:\s*\w+…`) will mangle some valid code (object literals with type-ish shapes, ternaries), acceptable for "simple apps," but Sandpack/WebContainers is the real fix (see roadmap).

### [HIGH] F6: One giant JSON is the only transport; a truncated response burns the whole spend

- **Where:** [parse-response.ts:84](../lib/parse-response.ts) (`parseGenerationResponse` → `null` on any parse failure), [route.ts:26](../app/api/generate/route.ts) (8,192 max output tokens on Haiku/Sonnet-4)
- **What I found:** New-project generation returns *all files* inside a single JSON object. If output hits `max_tokens` mid-string (very plausible: an 8K-output model writing a 10-file app), `JSON.parse` fails, the client shows "No response received. Please try again," and everything, including the 9 complete files inside the broken JSON, is discarded. There's no `stop_reason` check on the generate route, no repair, no continuation, no partial salvage.
- **Failure narrative:** Haiku selected for speed, "build me a dashboard with sidebar, charts and settings page" → 8K tokens ends inside file #7 → total loss, full price. Retry has the same odds.
- **Why it's easy to miss:** Sonnet 4.6's 64K output hides it most of the time; it resurfaces exactly when a user picks the FAST model or asks for something big.
- **Fix direction:** Three tiers, pick any: (1) detect `stop_reason === "max_tokens"` server-side and auto-continue the message, stitching output; (2) salvage parser that extracts complete `{path, content}` entries from truncated JSON (regex-scan for complete file objects) and reports which files are missing; (3) longer-term, move generation to the tool-use transport (one `write_file` call per file; the agent route already proves this pattern), which makes truncation lose one file, not everything.

### [HIGH] F7: GitHub push can silently fail at the last step, and deletions never reach the repo

- **Where:** [route.ts:165-177](../app/api/github/push/route.ts) (step 7: `PATCH …/git/refs/…` result never checked → falls through to `success: true`); step 5 (`base_tree` always kept, no deletion entries)
- **What I found:** Two independent issues. (a) If the branch ref update fails (non-fast-forward because the repo changed remotely, permissions, transient 5xx), the route still returns success with a commit SHA that no branch points to; the modal shows "Pushed successfully!" (b) The tree is built *on top of* `base_tree` with only additions/updates. Files deleted in Gostera are never deleted in the repo, forever.
- **Failure narrative:** You push, edit the repo README on github.com, generate more, push again → ref update rejected → green success UI, "View on GitHub" shows the old code. You ship the wrong version believing it's current.
- **Why it's easy to miss:** The Git Data API's multi-step dance succeeds 6 of 7 steps; the unchecked one is the only step that's visible to the world.
- **Fix direction:** Check the PATCH response; on 409/422 surface "remote has new commits" with a force option. For deletions: either omit `base_tree` and send the complete tree every push (simplest, matches the "full snapshot" mental model), or include `{path, mode, type, sha: null}` entries for deleted paths.

### [MEDIUM] F8: Two open tabs silently overwrite each other's entire state

- **Where:** [project-store.ts:363](../stores/project-store.ts) (zustand `persist` → IndexedDB), no cross-tab channel
- **What I found:** Each tab hydrates the whole store once at load and rewrites the *entire* state object on every `set()`. There is no storage-event/BroadcastChannel reconciliation. Tab B's first keystroke persists its stale snapshot over everything Tab A did.
- **Failure narrative:** Preview open in one tab, chat in another (a natural workflow this UI invites). Generate in tab A creates a project; rename something in tab B; tab B's write persists a projects array that has never heard of A's new project. It's gone on next reload.
- **Why it's easy to miss:** Solo use, one window, never fires. It's the classic "races never happen on the builder's machine."
- **Fix direction:** Cheapest: `navigator.locks.request("gostera", …)` at boot and show "already open in another tab" (single-tab lock). Better: BroadcastChannel that rehydrates other tabs after writes. The real cure is per-entity persistence (comes free with the F3 restructure or a real DB).

### [MEDIUM] F9: `/api/projects/sync` trusts a client-supplied absolute path; three sibling routes don't

- **Where:** [route.ts:31-36](../app/api/projects/sync/route.ts) (`if (folderPath) projectDir = folderPath`, no validation), contrast [folder/route.ts:110](../app/api/projects/folder/route.ts), [files/route.ts:80](../app/api/projects/files/route.ts), [install/route.ts:22](../app/api/projects/install/route.ts) which all validate against the projects root
- **What I found:** The sync route writes arbitrary files to any absolute directory the client names. The per-file traversal check is relative to that unvalidated root, and uses `startsWith(projectDir)` without a trailing separator (prefix-sibling bypass). Architecturally, the projects-root boundary is enforced in three places by copy-pasted code and simply missing in the fourth: the signature failure mode of duplicated boundary logic.
- **Failure narrative:** Any XSS or CSRF-ish foothold in this authenticated app becomes arbitrary file write on your machine (e.g. dropping a file into a startup location). Even without an attacker: a corrupted `folderPath` persisted in the store writes a project into a random directory and everything else "works."
- **Fix direction:** One shared `resolveProjectDir(projectId)` helper used by all four routes; derive the path server-side from the id, never accept absolute paths from the client. (Also the exploit-class item in the security handoff.)

### [MEDIUM] F10: Discuss mode answers questions about code it can only see 500 characters of

- **Where:** [route.ts:69-72](../app/api/discuss/route.ts) (`f.content.slice(0, 500)` for every file, `max_tokens: 2048`)
- **What I found:** The UI invites "Ask me anything about your project"; the route truncates each file to its first 500 chars. Claude will confidently describe functions it never saw. Discuss is also excluded from prompt caching (deliberate, per earlier session notes), which was reasonable when payloads were tiny, but it means the fix (sending real file content) needs the cache decision revisited.
- **Failure narrative:** "Why does my checkout total come out wrong?" The bug is at line 120; Claude saw lines 1 through 15 of that file and invents a plausible answer. The user "fixes" the wrong thing in Build mode, paying for both rounds.
- **Fix direction:** Reuse `selectFilesForContext(files, message)` with a budget (the module already exists and is prompt-aware), raise `max_tokens` to ~8K, and add the same file-context cache breakpoint the generate route uses.

### [MEDIUM] F11: Every agent run starts with amnesia, and the transcript evaporates on unmount

- **Where:** [agent-panel.tsx:228-241](../components/agent-panel.tsx) (`streamAgent` body, no `history` field despite the route supporting one), `items` in component `useState`
- **What I found:** The agent route accepts `history`, but the panel never sends it. Each run is context-free. The entire event feed lives in component state: toggle to Generate mode, switch projects, or reload, and it's gone (unlike Generate chat, which persists).
- **Failure narrative:** Run 1: "add a dark-mode toggle." Run 2: "also apply it to the settings page." The agent has no idea what "it" is and re-derives (or contradicts) run 1's approach, at full exploration cost each time.
- **Fix direction:** Persist an `agentTranscripts[projectId]` slice (prompt + final summary per run is enough, not every tool event) and send the last few prompt/summary pairs as `history`.

### [MEDIUM] F12: The context meter re-scans the whole project on every keystroke

- **Where:** [chat-panel.tsx:962-971](../components/chat-panel.tsx) (IIFE in render: `selectFilesForContext(files, input)` + `estimateRequestBudget`), [file-selector.ts:85](../lib/file-selector.ts) (`estimateTokens(files.map(f => f.content).join(""))`)
- **What I found:** Each render of the input (i.e., each keystroke) concatenates every file's content into one string (twice: selector and budget), scores all files, and sorts. That's O(total project bytes) per keypress.
- **Failure narrative:** At ~150 files / 2 MB (an imported real project), typing develops visible lag; at bigger sizes the input becomes gummy. It profiles as "React is slow," not as this IIFE.
- **Fix direction:** `useMemo` keyed on `(currentProject.id, files-reference, debounced input)`; precompute per-file token counts once per file change (store alongside content). ~30 minutes of work.

### [MEDIUM] F13: Every disk write from the store is fire-and-forget with an empty catch

- **Where:** [project-store.ts](../stores/project-store.ts): `updateFiles`, `mergeFiles`, `updateFileContent`, `deleteProject`, `createProject` all end in `.catch(() => {})`
- **What I found:** If a sync fails (server restarted, folder locked by a dev server, path invalid after manual folder deletion), the UI keeps confirming saves while the disk stays stale. Combined with F2, this widens the divergence window invisibly. `deleteProject`'s folder deletion failing silently also strands orphan folders.
- **Fix direction:** Bubble failures to a small toast ("Disk sync failed: retry"), keep a `lastSyncedAt`/`dirty` flag per project, surface it near the project name.

### [MEDIUM] F14: Approving your second plan executes your first plan's text

- **Where:** [agent-panel.tsx:362](../components/agent-panel.tsx): `items.find((i) => i.kind === "plan")`
- **What I found:** On approval, the code re-reads the plan content with `find`, which returns the **first** plan item in the whole feed, not the one just approved (`pendingPlanIdRef` exists but isn't used here). After one completed plan cycle, every later approval appends the *old* plan as "Approved plan: … execute this plan exactly as described."
- **Failure narrative:** Plan-first session: plan A executed, then you ask for feature B, review plan B, approve → the agent receives prompt B plus plan A as its instructions and dutifully re-executes A's steps "exactly as described."
- **Fix direction:** `items.find(i => i.kind === "plan" && i.id === approvedId)`. Pass the id through `executeApprovedPlan`.

### [MEDIUM] F15: Dead scaffolding, decorative chrome, and a project doc that describes a different app

- **Where:** `lib/db.ts` (entire `DataStore`/`LocalStorageDataStore`, zero imports anywhere; since deleted, so this path no longer exists), [use-keyboard-shortcuts.ts:44](../hooks/use-keyboard-shortcuts.ts) (`useAutoSave` = a `console.debug` loop), [sidebar.tsx:41-47](../components/sidebar.tsx) (Components/Assets/Deployment/Analytics nav: no handlers; "Docs"/"Support": no handlers; hardcoded "Pro Plan" badge, "V2.4.0-ALPHA"), [top-bar.tsx:26-30](../components/top-bar.tsx) ("Marketplace" tab: no content; "Share" copies your localhost URL), CLAUDE.md (says "Everything is localStorage only," but it's IndexedDB; says 80K file budget, but code says 200K; documents Ctrl+S, but no handler exists; presents `lib/db.ts` as the Supabase migration path, but nothing uses it)
- **What I found:** Classic AI-assisted-development drift. The dangerous one is `lib/db.ts` + CLAUDE.md: the *documented* migration strategy ("swap `LocalStorageDataStore` for `SupabaseDataStore`") is fiction, because real persistence is zustand-persist, which has a completely different shape. A future session (human or AI) will implement `SupabaseDataStore`, wire nothing, and wonder why nothing changed. The decorative buttons matter for your stated goal: nothing reads less premium than chrome that doesn't do anything.
- **Fix direction:** Delete `lib/db.ts` and `useAutoSave`, or make them real. Remove or implement each dead button (the Templates tab could become a real starter-gallery, see roadmap). Rewrite the stale CLAUDE.md sections: for an AI-driven project, CLAUDE.md accuracy is load-bearing infrastructure.

### [MEDIUM] F16: Cost numbers are wrong per model, cache reads are billed at full price in the UI, and nothing caps a run

- **Where:** [token-estimate.ts](../lib/token-estimate.ts) (hardcoded $3/$15 Sonnet pricing for every model), [route.ts:297-301](../app/api/agent/route.ts) (cache reads folded into `input_tokens` at face value, acknowledged as "conservative"), no budget guard in the agent loop
- **What I found:** Haiku usage is over-reported ~4×, Opus under-reported; cache-read tokens (90% discounted in reality) display at full price, so the dashboard systematically overstates cost in api-key mode and shows meaningless dollars in subscription mode (CLAUDE.md admits this). Meanwhile the one number that *should* exist, "stop this agent run if it exceeds $X / N tokens," doesn't; a 25-turn Opus run can output up to 128K tokens per turn with no ceiling but the turn count.
- **Fix direction:** Per-model pricing table (id → in/out/cache-read/cache-write rates); pass the model into `estimateCost`; report cache reads at cache rate with a "saved $Y via caching" line (nice premium touch); add an optional per-run token/dollar cap checked each turn in the agent loop.

### Low findings (noting, fine to defer)

- **L1:** Session tokens never expire (`Date.now()` in payload is never checked) and cookies last 10 years; a leaked token is forever. Fine solo; fix before anything multi-user.
- **L2:** Import caps at 200 files, disk-read-back at 300, agent manifest at 1000: three different silent truncation ceilings for the same concept; a 250-file project imports partially with no warning beyond the preview count.
- **L3:** Code panel renders one `<div>` per line number and re-highlights whole files; a 5k-line file makes the panel crawl. Virtualize or cap when you start opening big imported files.
- **L4:** In-memory rate limiters (documented) also key on `x-forwarded-for`, which is client-spoofable; irrelevant solo, worth knowing.
- **L5:** `search_files` reads every text file fully per query, fine at ≤1000 files by design.

---

## Checked and clean

- **Prompt caching architecture:** genuinely well done: rolling single message breakpoint in the agent loop (never exceeds the 4-breakpoint cap), separate cached file-context block in generate, correct tools→system→messages prefix reasoning. This is better than most production apps I see.
- **Path confinement in agent tools:** `resolveSafe` handles `..`, absolute paths, and the separator edge case correctly (symlink caveat handed to security review).
- **Auth plumbing:** constant-time password compare, HMAC via Web Crypto (Edge-compatible), HttpOnly/SameSite cookies, GitHub OAuth `state` CSRF check, middleware matcher. Right-sized for a personal tool.
- **Incremental-update schema** (`changedFiles`/`deletedFiles` + "everything else preserved"): sound design with explicit anti-bloat prompt rules; the merge implementation is correct.
- **Import pipeline:** filtering (node_modules, lockfiles, binaries, size caps), framework auto-detection, preview-before-commit: thorough.
- **IndexedDB move** for the project store: the right call over localStorage; the adapter is clean.
- **Concurrency of UI actions:** send buttons disable while generating; double-submit is guarded client-side.
- **Rate-limit header surfacing** (`anthropic-ratelimit-*` → UI buckets): a genuinely premium observability touch already in place.

## Handed off to security review

One-liners spotted in passing: run a dedicated security audit (the `security-audit` skill) before exposing this beyond localhost:

- `run_command` shell-metacharacter bypass + interpreter allowlist = arbitrary code execution reachable by prompt-injected file content (F4).
- `/api/projects/sync` arbitrary absolute-path write (F9).
- No login rate-limit/lockout (400ms delay only); session tokens unexpiring (L1).
- GitHub OAuth requests `delete_repo` scope that no code uses. Drop it (blast radius of a leaked `gh_token` cookie).
- `resolveSafe` doesn't resolve symlinks: a symlink inside a project escapes the sandbox for reads/writes.
- GitHub client secret was previously exposed in chat (already flagged in CLAUDE.md; regenerate if not done).

---

## Fix plan

### Phase 1: Stop the bleeding (this week; all Small, ~a day total)

| Item | Finding | Effort | Unblocks |
|---|---|---|---|
| Honor `req.signal` + break on closed stream in the agent loop | F1 | S | Trust in the Stop button; stops token waste |
| Auto-call `syncFromDisk()` on agent `done`; make `restoreVersion` sync to disk | F2 (⅔ of it) | S | Kills the two worst divergence stories |
| Swap Tailwind `<link>` for the Play CDN `<script>` | F5 | S | React previews styled again |
| Check the ref-update response in GitHub push | F7a | S | No more phantom "pushed" |
| Fix plan-approval to use the approved plan's id | F14 | S | Plan-first mode correct |
| Surface sync failures (toast + dirty flag) instead of `catch(() => {})` | F13 | S | Divergence becomes visible |

### Phase 2: Structural (next 2 to 4 weeks, before the next big feature)

| Item | Finding | Effort | Unblocks |
|---|---|---|---|
| Key `versions`, `chatMessages` (+ new agent transcripts) by `projectId`; stop clearing on switch | F3, F11 | M | Reliable rollback; agent follow-ups with context. **Do this before any Supabase move: it fixes the data model you'd migrate.** |
| Staleness guard: fingerprint disk before Generate merges onto a folder-backed project | F2 (last ⅓) | M | Ends the clobber race for good |
| Truncation resilience: `stop_reason` check + auto-continue or salvage parser | F6 | M | Big generations on cheap models stop being lotteries |
| Discuss mode: real file context via `selectFilesForContext` + cache breakpoint + 8K output | F10 | S/M | Discuss becomes trustworthy |
| Per-model pricing + cache-aware cost + per-run budget cap | F16 | S | Honest dashboard; bounded runs |
| Memoize the context meter; precompute per-file token counts | F12 | S | Smooth typing on large projects |
| Delete or implement dead chrome; delete `lib/db.ts` & `useAutoSave`; rewrite stale CLAUDE.md sections | F15 | S | Every future AI session works from truth |
| Shared `resolveProjectDir()` helper across all four project routes | F9 | S | One boundary, enforced once |
| GitHub push deletions (full tree or null-sha entries) | F7b | S | Repos mirror reality |

### Phase 3: When it matters (trigger-based)

- **Before anyone but you can reach the app** (tunnel, LAN, deploy): full security pass: F4 command sandboxing done honestly, L1 token expiry, login lockout, drop `delete_repo` scope.
- **Before importing untrusted third-party code regularly:** F4 (prompt-injection → run_command is the live wire).
- **Before a second device / cross-device use:** real DB (Supabase), but only after Phase 2's per-project keying, which *is* the migration-ready data model; plus F8's tab lock becomes obsolete with server state.
- **When projects regularly exceed ~100 files:** L3 virtualized/Monaco editor, L2 unified file-count limits.

---

# Premium Upgrade Roadmap

This is the "make it premium" half of your ask, product-level, beyond the structural fixes above. Ordered by leverage.

### 1. Invest in the framework prompts: this is the product
`lib/framework-prompts.ts` prompts are 5 to 10 lines each ("Use Tailwind. Use TypeScript strictly."). The visual and structural quality of every generated app is capped here, and it's the cheapest thing in the codebase to improve. What the premium tools (v0, Lovable, Bolt) actually differentiate on is exactly this layer. Give each framework:
- A **design system**: type scale, spacing rhythm, color/radius/shadow tokens, dark-mode rules, hover/focus/empty/loading/error states, responsive breakpoints, accessibility basics.
- **Taste constraints**: "generous whitespace, one accent color, no gradients unless asked, real placeholder content (never lorem ipsum)."
- **Architecture conventions** per framework (component boundaries, where state lives, file naming).
Expect a bigger perceived quality jump from two days of prompt work than from any feature you could build.

### 2. Instant in-browser preview for every framework (Sandpack or WebContainers)
The "run `npm run dev` yourself, then connect the port" flow is the single biggest gap between Gostera and the premium tier. **Sandpack** (`@codesandbox/sandpack-react`) gives you real bundled React/Vue/Svelte previews with npm deps as an embeddable component; it would replace the fragile regex-based CDN preview outright. **WebContainers** (StackBlitz) additionally runs Node servers in-browser if you want Express/Next preview. Start with Sandpack: an afternoon to prototype, transforms the core loop.

### 3. Stream the agent like a first-class product surface
Today the agent posts whole text blocks per turn (non-streaming `messages.create`) and finishes with a manual Sync. Premium version: token-streamed text (`messages.stream`), a **per-file diff card** after each `write_file` (you already have the diff engine in version-history-modal), accept/revert per file, auto-sync (Phase 1), and a live "files changed" tray. Same backend, dramatically different feel.

### 4. Git-backed checkpoints instead of the 10-version array
`git` is already on the allowlist and every folder-backed project lives on disk. `git init` each project folder and commit automatically before/after every generation and agent run. You get: unlimited history, real diffs, restore-any-point, branch experiments ("try this redesign on a branch"), and it makes GitHub push trivial and correct (push the actual repo, F7 disappears). This replaces the fragile versions array with infrastructure that already exists.

### 5. Upgrade the editor surface: CodeMirror 6 (or Monaco)
The code panel is a `<textarea>` with a highlight.js overlay and hand-rolled search. CodeMirror 6 gives proper editing, search/replace, folding, multi-cursor, and per-language modes at ~200KB. It also fixes L3 (virtualized rendering) for free. This is the surface a technical user touches most after chat.

### 6. One-click deploy
Export ZIP + GitHub push exist; the missing end of the loop is *shipping*. Easiest wins: Netlify's deploy API (drag-a-ZIP equivalent, no OAuth needed with a personal token) or Vercel's deployments API for Next.js projects. A "Deploy" button that returns a live URL is the moment this feels like a product instead of a workbench.

### 7. Make Discuss a real code copilot
After F10's fix, go further: let Discuss cite files ("in `src/App.tsx:42`…") and offer a one-click "Apply this suggestion in Build mode" handoff that pre-fills the prompt. Cheap to build, big perceived intelligence gain.

### 8. Turn the dead chrome into real features (or delete it)
- **Templates tab** → a real starter gallery: 8 to 10 curated, framework-tagged starting prompts with thumbnail previews (you already have the prompt-template plumbing).
- **Analytics** → point it at the usage dashboard you already built.
- **Marketplace, Deployment, Docs, Support, "Pro Plan"** → delete until real. Dead buttons are anti-premium; an app that does 8 things flawlessly reads as more premium than one that hints at 15.

### 9. Cost transparency as a feature
With F16 fixed, show per-project cost, per-run cost, cache savings ("caching saved $3.20 this week"), and a monthly trend in the usage dashboard. In subscription mode, show rate-limit bucket burn-down instead of fake dollars (the plumbing, `summarizeRateLimits`, already exists). Knowing what things cost is a premium trait; wrong numbers are worse than none.

### 10. Small polish items that punch above their weight
- Diff preview *before* applying a Generate result (show what will change, then Apply/Discard); you have the parts.
- Command palette (Ctrl+K) for project switching and actions.
- Fix Ctrl+S to actually force-sync + snapshot (it's documented but unimplemented).
- Error messages with next steps ("Rate limit hit, resets in 42s"; you already capture `retry-after`).
- Per-project model + full-context defaults (remembered), instead of global.

**Suggested sequencing:** Phase 1 fixes → prompt overhaul (#1) + Tailwind/preview quick wins → Sandpack (#2) → git checkpoints (#4) + agent streaming (#3) → editor (#5) → deploy (#6). That order front-loads the visible quality jump while the structural fixes keep it honest underneath.

---

# Resolution

All sixteen findings above were fixed. This section records what each fix
actually became, so the audit can be read against the current code.

| # | Fix |
|---|---|
| F1 | The agent route now honours `req.signal`, so Stop aborts the server-side loop, not just the UI. |
| F2 | A disk fingerprint is compared against the store and surfaces a Sync prompt when the two diverge. Restore now writes through to disk. |
| F3 | History is keyed per project (`versionsByProject`, `chatMessagesByProject`, `agentTranscripts`), so switching projects no longer wipes it. |
| F4 | The command runner no longer uses a shell. Argv is parsed directly, shell metacharacters are rejected, executables are allowlisted, git is limited to local subcommands, and inline-eval flags are blocked. Paths are confined both lexically and after realpath resolution. |
| F5 | The React preview stylesheet URL was corrected. |
| F6 | Truncated responses are salvaged: the parser walks the partial JSON and recovers every file object that completed. Output-token caps were also corrected per model, which was the underlying cause. |
| F7 | The final ref update is checked, and deletions now propagate to the repo. |
| F8 | A Web Locks based guard permits only one active tab. |
| F9 | All four routes derive the target directory server-side from the project id. Client-supplied absolute paths are no longer trusted. |
| F10 | Discuss mode uses the same real file selector as Generate instead of a 500-character preview. |
| F11 | Agent transcripts persist per project and are replayed into follow-up runs. |
| F12 | File token counts are cached in a WeakMap and the meter no longer recomputes while generating. |
| F13 | Sync failures set a `syncError` flag surfaced in the top bar rather than being swallowed. |
| F14 | Plan approval executes the approved plan rather than the first plan in the list. |
| F15 | Dead scaffolding was deleted and the project documentation rewritten to match the code. |
| F16 | Per-model pricing was corrected, cache reads are priced separately, and a per-run output-token ceiling was added. |

Two notes worth keeping, because they were the actual lesson of the exercise:

**Reading the code was not enough.** Three of these survived a careful read of the
diff and only surfaced when the app was run and observed. The salvage parser in
F6 looked correct on the page and recovered nothing at all in the one scenario it
existed for, because it stopped at the first incomplete object instead of stepping
past it. The token caps were stale constants that no review would flag as wrong.
The tab guard in F8 initially blocked a single legitimate tab, because React's
development double-mount grabbed the lock twice.

**F4 is limited, not solved.** The command runner constrains *what* the agent can
run, not *where* it runs. Executing `npm install` on a project is still real code
execution on the host machine. That is why Gostera is built to run locally rather
than as a hosted service, and container-level isolation is the next step if that
ever changes.
