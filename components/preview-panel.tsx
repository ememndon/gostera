"use client";

import { useUIStore } from "@/stores/ui-store";
import { useProjectStore } from "@/stores/project-store";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Monitor, Tablet, Smartphone, RefreshCw, Maximize2, Minimize2, ExternalLink, PlugZap, X } from "lucide-react";
import { useState, useRef, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";

const FRAMEWORK_LABELS: Record<string, { name: string; runCmd: string; installCmd: string; defaultPort: number }> = {
  "nextjs":       { name: "Next.js",          runCmd: "npm run dev",   installCmd: "npm install",                       defaultPort: 3000 },
  "react-vite":   { name: "React + Vite",      runCmd: "npm run dev",   installCmd: "npm install",                       defaultPort: 5173 },
  "node-express": { name: "Node.js / Express", runCmd: "npm run dev",   installCmd: "npm install",                       defaultPort: 3001 },
  "python-flask": { name: "Python / Flask",    runCmd: "python app.py", installCmd: "pip install -r requirements.txt",   defaultPort: 5000 },
  "vuejs":        { name: "Vue.js",            runCmd: "npm run dev",   installCmd: "npm install",                       defaultPort: 5173 },
  "svelte":       { name: "Svelte",            runCmd: "npm run dev",   installCmd: "npm install",                       defaultPort: 5173 },
};

function buildPreviewHtml(files: { path: string; content: string }[], framework: string): string | null {
  if (framework === "html-css-js") {
    const indexFile = files.find((f) => f.path === "index.html" || f.path === "public/index.html")
      ?? files.find((f) => f.path.endsWith(".html"));
    if (!indexFile) return null;

    let html = indexFile.content;
    const cssFile = files.find((f) => f.path === "styles.css" || f.path === "style.css");
    if (cssFile) {
      html = html.replace(
        /<link[^>]+href=["'](?:\.\/)?styles?\.css["'][^>]*>/gi,
        `<style>${cssFile.content}</style>`
      );
    }
    const jsFile = files.find((f) => f.path === "script.js" || f.path === "main.js" || f.path === "app.js");
    if (jsFile) {
      html = html.replace(
        /<script[^>]+src=["'](?:\.\/)?(?:script|main|app)\.js["'][^>]*><\/script>/gi,
        `<script>${jsFile.content}</script>`
      );
    }
    return html;
  }

  if (framework === "react-vite") {
    const appFile =
      files.find((f) => f.path === "src/App.tsx" || f.path === "src/App.jsx" || f.path === "App.tsx")
      ?? files.find((f) => f.path.endsWith("App.tsx") || f.path.endsWith("App.jsx"));
    if (!appFile) return null;

    const appCode = appFile.content
      .replace(/^import\s+.*?from\s+['"].*?['"]\s*;?\s*$/gm, "")
      .replace(/:\s*\w+(\[\])?(\s*\|\s*\w+(\[\])?)*(?=[,\)\s=])/g, "")
      .replace(/interface\s+\w+\s*\{[\s\S]*?\}/g, "")
      .replace(/type\s+\w+\s*=\s*[^;]+;/g, "")
      .trim();

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Preview</title>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  <script src="https://unpkg.com/react@18/umd/react.development.js"></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>body{margin:0;font-family:system-ui,sans-serif}</style>
</head>
<body>
  <div id="root"></div>
  <script type="text/babel">
    const { useState, useEffect, useCallback, useRef, useMemo } = React;
    ${appCode}
    const root = ReactDOM.createRoot(document.getElementById('root'));
    root.render(React.createElement(App));
  </script>
</body>
</html>`;
  }

  return null;
}

export function PreviewPanel() {
  const { previewDevice, setPreviewDevice, previewFullscreen, setPreviewFullscreen, localServerUrl, setLocalServerUrl } = useUIStore();
  const { currentProject } = useProjectStore();
  const [refreshKey, setRefreshKey] = useState(0);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [showServerInput, setShowServerInput] = useState(false);
  const [serverInputVal, setServerInputVal] = useState("");
  const serverInputRef = useRef<HTMLInputElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const deviceWidths = { mobile: "375px", tablet: "768px", desktop: "100%" };

  const framework = currentProject?.framework ?? "html-css-js";
  const files = currentProject?.files ?? [];
  const hasContent = files.length > 0;

  const previewHtml = hasContent ? buildPreviewHtml(files, framework) : null;
  const isStaticPreviewable = previewHtml !== null;
  const frameworkInfo = FRAMEWORK_LABELS[framework];

  // Is user connected to a local server?
  const hasLocalServer = Boolean(localServerUrl.trim());

  // Normalize URL: ensure it has http://
  const normalizeUrl = (url: string) => {
    const trimmed = url.trim();
    if (!trimmed) return "";
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;
    return `http://${trimmed}`;
  };

  const effectiveUrl = hasLocalServer ? normalizeUrl(localServerUrl) : null;

  // Create/revoke blob URL for "open in new tab" on static preview
  useEffect(() => {
    if (!previewHtml) { setBlobUrl(null); return; }
    const blob = new Blob([previewHtml], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    setBlobUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [previewHtml]);

  const handleRefresh = () => setRefreshKey((k) => k + 1);

  const handleOpenInNewTab = useCallback(() => {
    if (effectiveUrl) {
      window.open(effectiveUrl, "_blank", "noopener");
    } else if (blobUrl) {
      window.open(blobUrl, "_blank", "noopener");
    }
  }, [effectiveUrl, blobUrl]);

  const connectServer = () => {
    const url = normalizeUrl(serverInputVal);
    if (url) {
      setLocalServerUrl(url);
      setServerInputVal("");
    }
    setShowServerInput(false);
  };

  const disconnectServer = () => {
    setLocalServerUrl("");
    setShowServerInput(false);
  };

  useEffect(() => {
    if (showServerInput) {
      // Pre-fill with framework default port
      const port = frameworkInfo?.defaultPort ?? 3000;
      setServerInputVal(localServerUrl || `localhost:${port}`);
      setTimeout(() => serverInputRef.current?.select(), 50);
    }
  }, [showServerInput, frameworkInfo, localServerUrl]);

  const displayUrl = effectiveUrl
    ? effectiveUrl.replace(/^https?:\/\//, "")
    : isStaticPreviewable ? "preview" : "about:blank";

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Preview toolbar */}
      <div className="flex items-center gap-2 px-3 h-10 border-b border-border bg-card shrink-0">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Live Preview
        </span>

        <div className="flex items-center gap-0.5 ml-auto">
          {(["mobile", "tablet", "desktop"] as const).map((d) => (
            <Tooltip key={d}>
              <TooltipTrigger asChild>
                <Button
                  variant={previewDevice === d ? "secondary" : "ghost"}
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => setPreviewDevice(d)}
                >
                  {d === "mobile" && <Smartphone className="h-3.5 w-3.5" />}
                  {d === "tablet" && <Tablet className="h-3.5 w-3.5" />}
                  {d === "desktop" && <Monitor className="h-3.5 w-3.5" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {d.charAt(0).toUpperCase() + d.slice(1)} ({d === "desktop" ? "full" : deviceWidths[d]})
              </TooltipContent>
            </Tooltip>
          ))}
        </div>

        <div className="flex items-center gap-0.5">
          {/* Connect local server */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={hasLocalServer ? "secondary" : "ghost"}
                size="icon"
                className={cn("h-7 w-7", hasLocalServer && "text-green-400")}
                onClick={() => setShowServerInput(!showServerInput)}
              >
                <PlugZap className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {hasLocalServer ? `Connected: ${effectiveUrl}` : "Connect local dev server"}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleRefresh}>
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Refresh preview</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={previewFullscreen ? "secondary" : "ghost"}
                size="icon"
                className="h-7 w-7"
                onClick={() => setPreviewFullscreen(!previewFullscreen)}
              >
                {previewFullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{previewFullscreen ? "Exit fullscreen" : "Fullscreen preview"}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                disabled={!blobUrl && !effectiveUrl}
                onClick={handleOpenInNewTab}
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Open in new tab</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Local server input popover */}
      {showServerInput && (
        <div className="px-3 py-2 border-b border-border bg-card flex items-center gap-2">
          <PlugZap className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <input
            ref={serverInputRef}
            value={serverInputVal}
            onChange={(e) => setServerInputVal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") connectServer();
              if (e.key === "Escape") setShowServerInput(false);
            }}
            placeholder={`localhost:${frameworkInfo?.defaultPort ?? 3000}`}
            className="flex-1 text-xs bg-background border border-border rounded px-2 py-1.5 outline-none focus:ring-1 focus:ring-primary text-foreground"
          />
          <button
            onClick={connectServer}
            className="text-[10px] font-semibold px-2 py-1.5 rounded bg-primary/10 text-primary hover:bg-primary/20 transition-colors shrink-0"
          >
            Connect
          </button>
          {hasLocalServer && (
            <button
              onClick={disconnectServer}
              className="text-[10px] text-muted-foreground hover:text-destructive transition-colors shrink-0"
            >
              Disconnect
            </button>
          )}
          <button onClick={() => setShowServerInput(false)} className="text-muted-foreground hover:text-foreground shrink-0">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Preview area */}
      <div className="flex-1 flex items-center justify-center bg-preview-area overflow-hidden p-3">
        <div
          className="h-full flex flex-col rounded-xl overflow-hidden border border-border/60 shadow-2xl transition-all duration-300"
          style={{ width: deviceWidths[previewDevice], maxWidth: "100%" }}
        >
          {/* Browser chrome */}
          <div className="flex items-center gap-2 px-3 h-9 bg-card border-b border-border shrink-0">
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full bg-[#ff5f57] border border-[#e0443e]" />
              <span className="w-3 h-3 rounded-full bg-[#febc2e] border border-[#d4a017]" />
              <span className="w-3 h-3 rounded-full bg-[#28c840] border border-[#14a832]" />
            </div>
            <div className="flex-1 flex items-center gap-1.5 bg-background/60 border border-border/50 rounded-md px-2.5 h-6 mx-2">
              {hasLocalServer && (
                <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" title="Connected to local server" />
              )}
              <span className="text-[10px] text-primary/60 font-mono">🔒</span>
              <span className="text-[10px] text-muted-foreground/80 font-mono truncate">
                {displayUrl}
              </span>
            </div>
          </div>

          {/* Content area */}
          <div className="flex-1 bg-white overflow-hidden relative">
            {/* Local server takes priority */}
            {effectiveUrl ? (
              <iframe
                key={`local-${refreshKey}`}
                src={effectiveUrl}
                className="w-full h-full border-0"
                title="Local Dev Server"
              />
            ) : isStaticPreviewable && previewHtml ? (
              <iframe
                key={refreshKey}
                ref={iframeRef}
                srcDoc={previewHtml}
                sandbox="allow-scripts"
                className="w-full h-full border-0"
                title="Live Preview"
              />
            ) : hasContent && frameworkInfo ? (
              <div className="w-full h-full flex items-center justify-center bg-preview-placeholder p-6">
                <div className="text-center space-y-4 max-w-xs">
                  <div className="w-14 h-14 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto">
                    <span className="text-2xl">⚡</span>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-foreground">{frameworkInfo.name}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Connect your local dev server to see the live preview here.
                    </p>
                  </div>
                  {/* Quick connect button */}
                  <button
                    onClick={() => setShowServerInput(true)}
                    className="flex items-center gap-2 mx-auto px-4 py-2 rounded-lg bg-primary/10 border border-primary/20 text-primary text-sm font-medium hover:bg-primary/20 transition-colors"
                  >
                    <PlugZap className="h-4 w-4" />
                    Connect localhost:{frameworkInfo.defaultPort}
                  </button>
                  <div className="text-left bg-black/40 rounded-lg p-3 space-y-1.5 border border-border/40">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-widest font-semibold mb-2">Run locally</p>
                    <code className="block text-xs font-mono text-green-400">{frameworkInfo.installCmd}</code>
                    <code className="block text-xs font-mono text-green-400">{frameworkInfo.runCmd}</code>
                  </div>
                </div>
              </div>
            ) : (
              <div className="w-full h-full flex items-center justify-center bg-preview-placeholder">
                <div className="text-center space-y-3 p-8">
                  <div className="w-14 h-14 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto">
                    <span className="text-2xl">⚡</span>
                  </div>
                  <p className="text-sm font-semibold text-foreground">Live Preview</p>
                  <p className="text-xs text-muted-foreground max-w-[200px]">
                    Generate an HTML/CSS/JS app to see the live preview here.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
