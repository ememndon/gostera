"use client";

import { useEffect } from "react";
import { useUIStore } from "@/stores/ui-store";
import { useProjectStore } from "@/stores/project-store";
import { exportAsZip } from "@/lib/export";

export function useUIKeyboardShortcuts() {
  const { toggleSidebar, toggleCodeEditor, toggleMode } = useUIStore();
  const { currentProject } = useProjectStore();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;

      if (e.key === "b") {
        e.preventDefault();
        toggleSidebar();
      }
      if (e.key === "j") {
        e.preventDefault();
        toggleCodeEditor();
      }
      if (e.key === "d") {
        e.preventDefault();
        toggleMode();
      }
      if (e.key === "e") {
        e.preventDefault();
        if (currentProject && currentProject.files.length > 0) {
          exportAsZip(currentProject.name, currentProject.files);
        }
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggleSidebar, toggleCodeEditor, toggleMode, currentProject]);
}
