# Media assets

Images referenced by the root `README.md`. Drop files here using **exactly** these
filenames and they will appear in the project page automatically.

| Filename | What it should show | Referenced as |
|---|---|---|
| `video-poster.png` | A still frame from the demo video, used as the clickable thumbnail | Demo video section |
| `screenshot-build.png` | Build mode: a prompt running with the live preview beside it | Screenshots #1 |
| `screenshot-agent.png` | Agent mode mid-run: the tool steps streaming as it works | Screenshots #2 |
| `screenshot-editor.png` | The code editor with the file tree and syntax highlighting | Screenshots #3 |
| `screenshot-usage.png` | The usage dashboard: token spend, cost, rate limits | Screenshots #4 |

## Guidelines

- **Format:** PNG for UI captures. JPG is fine for the video poster.
- **Width:** 1600–2000px works well. GitHub scales down, so wider than the app
  window is better than narrower.
- **Size:** keep each under about 1.5 MB. Large PNGs make the repo slow to clone.
- **Capture the app at desktop width.** Gostera warns below 1024px, so a narrow
  capture will show the warning overlay instead of the UI.
- **Check for anything private** before committing — project names, file paths,
  API keys visible in a settings panel, or anything in a browser tab strip. These
  images are public and permanent once pushed.

The video itself is hosted off-repo at
`https://ememndon.com/videos/gostera.mp4`, so only the poster image lives here.
