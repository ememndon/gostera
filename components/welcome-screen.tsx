"use client";

import Image from "next/image";
import { useUIStore } from "@/stores/ui-store";
import { useProjectStore } from "@/stores/project-store";
import type { Framework } from "@/lib/types";
import { Upload } from "lucide-react";

const QUICK_START: { framework: Framework; label: string; icon: string; description: string }[] = [
  { framework: "html-css-js", label: "HTML / CSS / JS", icon: "🌐", description: "Classic web, no build tools" },
  { framework: "react-vite", label: "React + Vite", icon: "⚛", description: "Modern React with Tailwind" },
  { framework: "nextjs", label: "Next.js 14", icon: "▲", description: "Full-stack React framework" },
  { framework: "vuejs", label: "Vue.js 3", icon: "💚", description: "Progressive JS framework" },
  { framework: "svelte", label: "Svelte", icon: "🔶", description: "Compiled, fast UI framework" },
  { framework: "node-express", label: "Node / Express", icon: "🟢", description: "REST API backend" },
  { framework: "python-flask", label: "Python / Flask", icon: "🐍", description: "Lightweight Python API" },
];

interface Props {
  onImport: () => void;
}

export function WelcomeScreen({ onImport }: Props) {
  const { setFramework } = useUIStore();
  const { createProject } = useProjectStore();

  const handleStart = (framework: Framework) => {
    setFramework(framework);
    createProject("Untitled Project", framework);
  };

  return (
    <div className="flex-1 overflow-y-auto flex flex-col items-center justify-center p-8 gap-8">
      <div className="text-center space-y-2 flex flex-col items-center">
        <Image
          src="/logo.png"
          alt="Gostera"
          width={88}
          height={88}
          className="w-[88px] h-[88px] mb-4"
          priority
        />
        <h1 className="text-3xl font-bold tracking-tight">Welcome to Gostera</h1>
        <p className="text-muted-foreground">
          Describe an app in plain English — AI generates working code instantly
        </p>
      </div>

      {/* Quick start grid */}
      <div>
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3 text-center">
          Quick Start
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 max-w-2xl">
          {QUICK_START.map((qs) => (
            <button
              key={qs.framework}
              onClick={() => handleStart(qs.framework)}
              className="flex flex-col items-center gap-2 p-4 rounded-xl border border-border bg-card hover:border-primary hover:bg-accent transition-all text-left group"
            >
              <span className="text-2xl">{qs.icon}</span>
              <div>
                <p className="text-sm font-medium group-hover:text-primary transition-colors">
                  {qs.label}
                </p>
                <p className="text-xs text-muted-foreground">{qs.description}</p>
              </div>
            </button>
          ))}

          {/* Import existing project card */}
          <button
            onClick={onImport}
            className="flex flex-col items-center gap-2 p-4 rounded-xl border border-dashed border-border bg-card hover:border-primary hover:bg-accent transition-all text-left group"
          >
            <div className="w-8 h-8 rounded-md bg-muted/60 flex items-center justify-center group-hover:bg-primary/10 transition-colors">
              <Upload className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
            </div>
            <div>
              <p className="text-sm font-medium group-hover:text-primary transition-colors">
                Import Project
              </p>
              <p className="text-xs text-muted-foreground">Load from folder or ZIP</p>
            </div>
          </button>
        </div>
      </div>

      {/* Tips */}
      <div className="max-w-md text-center space-y-1">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Tips</p>
        <ul className="text-xs text-muted-foreground space-y-1">
          <li>💡 Use <strong>Build mode</strong> to generate code</li>
          <li>💬 Switch to <strong>Discuss mode</strong> to plan or ask questions</li>
          <li>📦 Export your project as a <strong>.zip</strong> anytime</li>
          <li>⌨️ Press <strong>?</strong> to see all keyboard shortcuts</li>
          <li>📂 Import existing projects from your drive to continue in Gostera</li>
        </ul>
      </div>
    </div>
  );
}
