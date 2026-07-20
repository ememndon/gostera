"use client";

import Image from "next/image";
import { useUIStore } from "@/stores/ui-store";
import { useProjectStore } from "@/stores/project-store";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  FolderOpen,
  MoreHorizontal,
  Pencil,
  Trash2,
  Check,
  X,
  Search,
  Upload,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Framework } from "@/lib/types";
import { useState, useRef, useEffect, useMemo } from "react";

const FRAMEWORKS: { value: Framework; label: string; icon: string }[] = [
  { value: "nextjs", label: "Next.js", icon: "▲" },
  { value: "react-vite", label: "React (Vite)", icon: "⚛" },
  { value: "html-css-js", label: "HTML / CSS / JS", icon: "🌐" },
  { value: "node-express", label: "Node.js / Express", icon: "🟢" },
  { value: "python-flask", label: "Python / Flask", icon: "🐍" },
  { value: "vuejs", label: "Vue.js", icon: "💚" },
  { value: "svelte", label: "Svelte", icon: "🔶" },
];

function ProjectMenu({
  projectId,
  projectName,
  onClose,
}: {
  projectId: string;
  projectName: string;
  onClose: () => void;
}) {
  const { renameProject, deleteProject, currentProject, switchProject } = useProjectStore();
  const [mode, setMode] = useState<"menu" | "rename" | "confirm-delete">("menu");
  const [renameVal, setRenameVal] = useState(projectName);
  const renameRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  useEffect(() => {
    if (mode === "rename") {
      setRenameVal(projectName);
      setTimeout(() => {
        renameRef.current?.select();
      }, 0);
    }
  }, [mode, projectName]);

  const commitRename = () => {
    const trimmed = renameVal.trim();
    if (trimmed && trimmed !== projectName) {
      renameProject(projectId, trimmed);
    }
    onClose();
  };

  const commitDelete = () => {
    deleteProject(projectId);
    onClose();
  };

  return (
    <div
      ref={menuRef}
      className="absolute left-0 right-0 top-full mt-0.5 z-50 bg-popover border border-border rounded-lg shadow-xl overflow-hidden"
      onClick={(e) => e.stopPropagation()}
    >
      {mode === "menu" && (
        <>
          <button
            onClick={() => setMode("rename")}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-foreground hover:bg-accent/60 transition-colors"
          >
            <Pencil className="h-3 w-3 text-muted-foreground" />
            Rename
          </button>
          <button
            onClick={() => setMode("confirm-delete")}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-destructive hover:bg-destructive/10 transition-colors"
          >
            <Trash2 className="h-3 w-3" />
            Delete
          </button>
        </>
      )}

      {mode === "rename" && (
        <div className="p-2 space-y-1.5">
          <input
            ref={renameRef}
            value={renameVal}
            onChange={(e) => setRenameVal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") onClose();
            }}
            className="w-full text-xs bg-background border border-border rounded px-2 py-1.5 outline-none focus:ring-1 focus:ring-primary"
            placeholder="Project name"
          />
          <div className="flex gap-1">
            <button
              onClick={commitRename}
              className="flex-1 flex items-center justify-center gap-1 py-1 rounded text-xs bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
            >
              <Check className="h-3 w-3" /> Save
            </button>
            <button
              onClick={onClose}
              className="flex items-center justify-center px-2 py-1 rounded text-xs text-muted-foreground hover:bg-accent/50 transition-colors"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        </div>
      )}

      {mode === "confirm-delete" && (
        <div className="p-2 space-y-2">
          <p className="text-[11px] text-muted-foreground leading-snug">
            Delete <span className="font-semibold text-foreground">{projectName}</span>?<br />
            This also removes the project folder from disk.
          </p>
          <div className="flex gap-1">
            <button
              onClick={commitDelete}
              className="flex-1 flex items-center justify-center gap-1 py-1 rounded text-xs bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors"
            >
              <Trash2 className="h-3 w-3" /> Delete
            </button>
            <button
              onClick={onClose}
              className="flex items-center justify-center px-2 py-1 rounded text-xs text-muted-foreground hover:bg-accent/50 transition-colors"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

interface SidebarProps {
  onImport: () => void;
}

export function Sidebar({ onImport }: SidebarProps) {
  const { sidebarOpen, toggleSidebar, selectedFramework, setFramework } = useUIStore();
  const { currentProject, projects, createProject, switchProject } = useProjectStore();
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [projectSearch, setProjectSearch] = useState("");

  const filteredProjects = useMemo(() => {
    if (!projectSearch.trim()) return projects;
    const q = projectSearch.toLowerCase();
    return projects.filter((p) => p.name.toLowerCase().includes(q) || p.framework.toLowerCase().includes(q));
  }, [projects, projectSearch]);

  const handleNewProject = () => {
    createProject("Untitled Project", selectedFramework);
  };

  return (
    <div
      className={cn(
        "flex flex-col h-full border-r border-border transition-all duration-300 overflow-hidden shrink-0",
        "bg-sidebar",
        sidebarOpen ? "w-52" : "w-12"
      )}
    >
      {/* Brand header */}
      <div className="flex items-center justify-between h-12 px-3 border-b border-border shrink-0">
        {sidebarOpen && (
          <div className="flex items-center gap-2 min-w-0">
            <Image
              src="/logo.png"
              alt="Gostera"
              width={28}
              height={28}
              className="w-7 h-7 shrink-0"
              priority
            />
            <div className="min-w-0">
              <p className="text-xs font-bold text-foreground leading-none truncate">
                Gostera Studio
              </p>
              <p className="text-[10px] text-primary/70 leading-none mt-0.5 font-mono">
                V2.4.0-ALPHA
              </p>
            </div>
          </div>
        )}
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleSidebar}
          className="h-7 w-7 shrink-0 ml-auto text-muted-foreground hover:text-foreground"
        >
          {sidebarOpen ? (
            <ChevronLeft className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>

      {/* New project + Import buttons */}
      <div className={cn("px-2 py-2.5 shrink-0 flex gap-1.5", !sidebarOpen && "justify-center flex-col items-center")}>
        <Button
          size="sm"
          onClick={handleNewProject}
          className={cn(
            "bg-primary text-primary-foreground hover:bg-primary/90 font-medium text-xs cyan-glow",
            sidebarOpen ? "flex-1" : "h-8 w-8 p-0"
          )}
          title="New Project"
        >
          <Plus className="h-3.5 w-3.5" />
          {sidebarOpen && <span className="ml-1.5">New Project</span>}
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              variant="outline"
              onClick={onImport}
              className={cn(
                "text-xs border-border text-muted-foreground hover:text-primary hover:border-primary/50",
                sidebarOpen ? "px-2.5" : "h-8 w-8 p-0"
              )}
              title="Import Project"
            >
              <Upload className="h-3.5 w-3.5" />
              {sidebarOpen && <span className="ml-1.5">Import</span>}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">Import existing project</TooltipContent>
        </Tooltip>
      </div>

      {sidebarOpen ? (
        <>
          {/* Framework selector */}
          <div className="px-3 pb-1 shrink-0">
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-1">
              Framework
            </p>
            <div className="space-y-0.5">
              {FRAMEWORKS.map((fw) => (
                <button
                  key={fw.value}
                  onClick={() => setFramework(fw.value)}
                  className={cn(
                    "w-full text-left flex items-center gap-2 px-2 py-1.5 rounded-md text-xs transition-colors",
                    selectedFramework === fw.value
                      ? "bg-primary/10 text-primary font-semibold"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                  )}
                >
                  <span className="w-4 text-center shrink-0">{fw.icon}</span>
                  <span className="truncate">{fw.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="mx-3 border-t border-border my-1" />

          {/* Recent projects */}
          <div className="flex-1 overflow-y-auto px-3 scrollbar-thin flex flex-col min-h-0">
            <div className="flex items-center justify-between mb-1">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">
                Recent
              </p>
            </div>
            {/* Project search */}
            {projects.length > 3 && (
              <div className="flex items-center gap-1.5 bg-muted/40 border border-border/60 rounded-md px-2 py-1 mb-1.5">
                <Search className="h-3 w-3 text-muted-foreground shrink-0" />
                <input
                  value={projectSearch}
                  onChange={(e) => setProjectSearch(e.target.value)}
                  placeholder="Search projects…"
                  className="flex-1 bg-transparent text-xs outline-none text-foreground placeholder:text-muted-foreground/60"
                />
                {projectSearch && (
                  <button onClick={() => setProjectSearch("")} className="text-muted-foreground hover:text-foreground">
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            )}
            {filteredProjects.length === 0 ? (
              <p className="text-xs text-muted-foreground/60 px-2">
                {projects.length === 0 ? "No projects yet" : "No matches"}
              </p>
            ) : (
              <div className="space-y-0.5">
                {filteredProjects.map((p) => (
                  <div key={p.id} className="relative group">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          onClick={() => switchProject(p.id)}
                          className={cn(
                            "w-full text-left flex items-center gap-2 px-2 py-1.5 rounded-md text-xs transition-colors pr-7",
                            currentProject?.id === p.id
                              ? "bg-primary/10 text-primary font-medium"
                              : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                          )}
                        >
                          <FolderOpen className="h-3 w-3 shrink-0" />
                          <span className="truncate">{p.name}</span>
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="right">
                        <span className="block">{p.framework} · {new Date(p.createdAt).toLocaleDateString()}</span>
                        {p.folderPath && (
                          <span className="block text-[10px] opacity-60 mt-0.5 max-w-[260px] break-all">{p.folderPath}</span>
                        )}
                      </TooltipContent>
                    </Tooltip>

                    {/* (...) menu button */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenMenuId(openMenuId === p.id ? null : p.id);
                      }}
                      className={cn(
                        "absolute right-1 top-1/2 -translate-y-1/2 h-5 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors",
                        openMenuId === p.id ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                      )}
                      title="More options"
                    >
                      <MoreHorizontal className="h-3 w-3" />
                    </button>

                    {/* Dropdown menu */}
                    {openMenuId === p.id && (
                      <ProjectMenu
                        projectId={p.id}
                        projectName={p.name}
                        onClose={() => setOpenMenuId(null)}
                      />
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="border-t border-border p-2 shrink-0">
            <div className="flex items-center gap-2 px-2 py-1.5">
              <Image
                src="/logo.png"
                alt=""
                width={24}
                height={24}
                className="w-6 h-6 shrink-0"
              />
              <div className="min-w-0">
                <p className="text-[10px] font-semibold text-foreground truncate">
                  Gostera Studio
                </p>
              </div>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
