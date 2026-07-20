# Gostera — AI App Builder

Personal, single-user AI app builder. Describe an app in plain English; Claude or
Gemini generates working code; the result appears in a live preview. Next.js 14,
runs as a normal Node process.

> **About this repository.** This is a public snapshot of Gostera, published so
> the code can be read and reviewed. Active development happens in a private
> repository, so this copy may lag slightly behind. It is complete and runnable:
> nothing has been stripped out except local environment files. If you want the
> quickest sense of the engineering, start with
> [`lib/agent-tools.ts`](lib/agent-tools.ts) for the sandboxed command runner,
> [`app/api/agent/route.ts`](app/api/agent/route.ts) for the agent tool loop, and
> [`docs/ARCHITECTURE-AUDIT.md`](docs/ARCHITECTURE-AUDIT.md) for a full
> self-audit of the codebase and what came out of it.

---

## ⚠️ READ THIS BEFORE DEPLOYING TO A SERVER

**This app has no authentication, and Agent mode executes commands on the machine
it runs on.**

Anyone who can reach the port can use Agent mode to read, write and delete files
in the projects directory and run `npm`/`node`/`python`/`git` commands **as the
user running the app**. There is no login, no session and no API token, because
Gostera is built as a single-user tool that runs on your own machine.

If you expose this to the internet as-is, you are handing shell-adjacent access
to anyone who finds the IP.

Pick at least one of these before exposing it:

1. **Don't expose it.** Bind to localhost and reach it over an SSH tunnel:
   ```bash
   # on the VPS
   HOSTNAME=127.0.0.1 npm start
   # from your laptop
   ssh -L 3000:127.0.0.1:3000 user@your-vps      # then open http://localhost:3000
   ```
   This is the safest option and needs no code changes.
2. **Put an authenticating reverse proxy in front** (Caddy `basicauth`, nginx
   `auth_basic`, Cloudflare Access, Tailscale). Bind the app to `127.0.0.1` so
   only the proxy can reach it.
3. **Restrict by firewall** to your own IP (`ufw allow from <your-ip> to any port 3000`).

Also: run it as a **dedicated unprivileged user**, never root — Agent mode's
command allowlist confines *what* runs, not *who* it runs as.

---

## Requirements

- Node.js 18.17+ (20 LTS or newer recommended)
- npm

## Setup

```bash
git clone https://github.com/ememndon/gostera.git
cd gostera
npm install
cp .env.example .env.local     # then edit .env.local and add at least one AI key
```

You need **at least one** AI provider key in `.env.local`:

| Variable | What it enables |
|---|---|
| `GEMINI_API_KEY` | Gemini 3.5 Flash — **free tier**, works in all modes. Get one at [aistudio.google.com](https://aistudio.google.com) |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude models via a Pro/Max subscription (`claude setup-token`) |
| `ANTHROPIC_API_KEY` | Claude models via metered API billing |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | Optional — the "Push to GitHub" button |

## Run

Development:
```bash
npm run dev        # http://localhost:3000
```

Production:
```bash
npm run build
npm start          # defaults to port 3000; PORT=8080 npm start to change
```

> Don't run `npm run build` while `npm run dev` is running — they share the
> `.next` directory and will corrupt each other. Stop one first.

### Keeping it running (systemd)

```ini
# /etc/systemd/system/gostera.service
[Unit]
Description=Gostera
After=network.target

[Service]
Type=simple
User=gostera                       # dedicated non-root user
WorkingDirectory=/home/gostera/gostera
Environment=NODE_ENV=production
Environment=HOSTNAME=127.0.0.1     # localhost-only; see the warning above
ExecStart=/usr/bin/npm start
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now gostera
```

## Where your data lives

- **Generated projects on disk:** a `projects/` directory created **as a sibling
  of this repo** (i.e. `../projects` relative to the app). The process user must
  be able to write to the parent directory. Agent mode is confined to this tree.
- **Projects, chat, versions in the browser:** IndexedDB, per browser profile.
  Nothing is stored server-side, so a fresh browser starts empty and the app is
  effectively **single-user** — it also enforces a single open tab.

## Modes

- **Generate** — one-shot: prompt in, whole app out, merged into your project.
- **Agent** — autonomous tool loop; reads/writes real files on disk, runs builds,
  fixes its own errors. Requires a project that has been synced to disk.
- **Discuss** — read-only Q&A about the project, no file changes.

## Documentation

`CLAUDE.md` in this directory is the full technical reference — architecture,
API routes, provider adapters, storage model, and known constraints.
