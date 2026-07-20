import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { idbStorage } from "@/lib/idb-storage";
import type {
  Project,
  ProjectFile,
  Framework,
  ChatMessage,
  PromptTemplate,
  ProjectVersion,
  GenerationLog,
} from "@/lib/types";
import { nanoid } from "@/lib/nanoid";

/** One completed agent run: the prompt and the agent's final summary. (F11) */
export interface AgentTranscriptEntry {
  prompt: string;
  summary: string;
  createdAt: string;
}

interface ProjectState {
  projects: Project[];
  currentProject: Project | null;
  chatMessages: ChatMessage[];
  promptTemplates: PromptTemplate[];
  versions: ProjectVersion[];
  generationLogs: GenerationLog[];

  // Per-project history. `versions`/`chatMessages` above are the *current
  // project's* view; these maps hold every project's history so switching
  // projects no longer wipes them. (F3) `agentTranscripts` gives agent runs
  // cross-run memory. (F11)
  versionsByProject: Record<string, ProjectVersion[]>;
  chatMessagesByProject: Record<string, ChatMessage[]>;
  agentTranscripts: Record<string, AgentTranscriptEntry[]>;
  addAgentTranscript: (projectId: string, entry: AgentTranscriptEntry) => void;

  /** Set when a disk sync fails so the UI can surface divergence. Null = healthy. */
  syncError: string | null;
  /** ISO timestamp of the last successful disk sync (informational). */
  lastSyncedAt: string | null;
  clearSyncError: () => void;

  createProject: (name: string, framework: Framework) => Project;
  switchProject: (projectId: string) => void;
  updateProjectName: (name: string) => void;
  renameProject: (projectId: string, name: string) => void;
  deleteProject: (projectId: string) => void;
  setCurrentProject: (project: Project | null) => void;
  updateFiles: (files: ProjectFile[], description?: string) => void;
  mergeFiles: (changedFiles: ProjectFile[], deletedFiles: string[], description?: string) => void;
  updateFileContent: (path: string, content: string) => void;
  snapshotCurrentFiles: (description?: string) => void;
  restoreVersion: (version: ProjectVersion) => void;
  addChatMessage: (message: Omit<ChatMessage, "id" | "createdAt">) => void;
  updateLastAssistantMessage: (content: string) => void;
  clearChatMessages: () => void;
  addPromptTemplate: (template: Omit<PromptTemplate, "id">) => void;
  removePromptTemplate: (id: string) => void;
  addGenerationLog: (log: Omit<GenerationLog, "id" | "createdAt">) => void;
}

const DEFAULT_TEMPLATES: PromptTemplate[] = [
  { id: "t1", label: "Landing page", text: "Build a landing page for " },
  { id: "t2", label: "Dashboard", text: "Build a dashboard that shows " },
  { id: "t3", label: "CRUD app", text: "Build a CRUD app for " },
  { id: "t4", label: "Add auth", text: "Add authentication to this app" },
  { id: "t5", label: "Mobile responsive", text: "Make this responsive for mobile" },
];

// Shared disk-sync helper. Unlike the old fire-and-forget `.catch(() => {})`,
// this surfaces failures to the store (`syncError`) so the UI can warn that the
// disk copy has diverged from what the editor shows, and records the last
// successful sync time. (F13)
function syncFilesToDisk(
  payload: { projectId: string; projectName: string; files: ProjectFile[]; folderPath?: string },
  onError: (msg: string) => void,
  onSuccess: () => void,
): Promise<void> {
  return fetch("/api/projects/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
    .then(async (res) => {
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `Disk sync failed (HTTP ${res.status})`);
      }
      onSuccess();
    })
    .catch((err: unknown) => {
      onError(err instanceof Error ? err.message : "Disk sync failed");
    });
}

export const useProjectStore = create<ProjectState>()(
  persist(
    (set, get) => ({
      projects: [],
      currentProject: null,
      chatMessages: [],
      promptTemplates: DEFAULT_TEMPLATES,
      versions: [],
      generationLogs: [],
      versionsByProject: {},
      chatMessagesByProject: {},
      agentTranscripts: {},
      syncError: null,
      lastSyncedAt: null,

      clearSyncError: () => set({ syncError: null }),

      addAgentTranscript: (projectId, entry) => {
        set((state) => ({
          agentTranscripts: {
            ...state.agentTranscripts,
            // keep the last 10 runs per project
            [projectId]: [...(state.agentTranscripts[projectId] ?? []), entry].slice(-10),
          },
        }));
      },

      createProject: (name, framework) => {
        const project: Project = {
          id: nanoid(),
          name,
          framework,
          files: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        set((state) => ({
          projects: [project, ...state.projects],
          currentProject: project,
          // Stash the outgoing project's history before switching to the new,
          // empty one — don't discard it. (F3)
          ...(state.currentProject
            ? {
                versionsByProject: { ...state.versionsByProject, [state.currentProject.id]: state.versions },
                chatMessagesByProject: { ...state.chatMessagesByProject, [state.currentProject.id]: state.chatMessages },
              }
            : {}),
          chatMessages: [],
          versions: [],
        }));

        fetch("/api/projects/folder", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId: project.id, projectName: project.name }),
        })
          .then((res) => res.json())
          .then((data: { folderPath?: string }) => {
            if (data.folderPath) {
              set((state) => ({
                projects: state.projects.map((p) =>
                  p.id === project.id ? { ...p, folderPath: data.folderPath } : p
                ),
                currentProject:
                  state.currentProject?.id === project.id
                    ? { ...state.currentProject, folderPath: data.folderPath }
                    : state.currentProject,
              }));
            }
          })
          .catch(() => {});

        return project;
      },

      switchProject: (projectId) => {
        const project = get().projects.find((p) => p.id === projectId);
        if (!project) return;
        set((state) => {
          // Stash outgoing project's history, then load the incoming one's. (F3)
          const versionsByProject = state.currentProject
            ? { ...state.versionsByProject, [state.currentProject.id]: state.versions }
            : state.versionsByProject;
          const chatMessagesByProject = state.currentProject
            ? { ...state.chatMessagesByProject, [state.currentProject.id]: state.chatMessages }
            : state.chatMessagesByProject;
          return {
            currentProject: project,
            versionsByProject,
            chatMessagesByProject,
            versions: versionsByProject[projectId] ?? [],
            chatMessages: chatMessagesByProject[projectId] ?? [],
          };
        });
      },

      updateProjectName: (name) => {
        const p = get().currentProject;
        if (!p) return;
        get().renameProject(p.id, name);
      },

      renameProject: (projectId, name) => {
        const project = get().projects.find((p) => p.id === projectId);
        if (!project) return;
        const updated = { ...project, name, updatedAt: new Date().toISOString() };

        set((state) => ({
          projects: state.projects.map((p) => (p.id === projectId ? updated : p)),
          currentProject:
            state.currentProject?.id === projectId ? updated : state.currentProject,
        }));

        fetch("/api/projects/folder", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            projectId,
            projectName: name,
            oldFolderPath: project.folderPath,
          }),
        })
          .then((res) => res.json())
          .then((data: { folderPath?: string }) => {
            if (data.folderPath) {
              set((state) => ({
                projects: state.projects.map((p) =>
                  p.id === projectId ? { ...p, folderPath: data.folderPath } : p
                ),
                currentProject:
                  state.currentProject?.id === projectId
                    ? { ...state.currentProject, folderPath: data.folderPath }
                    : state.currentProject,
              }));
            }
          })
          .catch(() => {});
      },

      deleteProject: (projectId) => {
        const project = get().projects.find((p) => p.id === projectId);
        if (!project) return;

        const remainingProjects = get().projects.filter((p) => p.id !== projectId);
        const wasCurrent = get().currentProject?.id === projectId;
        const nextCurrent = wasCurrent
          ? remainingProjects[0] ?? null
          : get().currentProject;

        set((state) => {
          // Drop the deleted project's stored history entirely.
          const versionsByProject = { ...state.versionsByProject };
          const chatMessagesByProject = { ...state.chatMessagesByProject };
          const agentTranscripts = { ...state.agentTranscripts };
          delete versionsByProject[projectId];
          delete chatMessagesByProject[projectId];
          delete agentTranscripts[projectId];

          if (wasCurrent) {
            // Load the next project's own history — never inherit the deleted
            // (or previous) project's chat/versions. (F3 chat-bleed fix)
            return {
              projects: remainingProjects,
              currentProject: nextCurrent,
              versionsByProject,
              chatMessagesByProject,
              agentTranscripts,
              versions: nextCurrent ? versionsByProject[nextCurrent.id] ?? [] : [],
              chatMessages: nextCurrent ? chatMessagesByProject[nextCurrent.id] ?? [] : [],
            };
          }
          // Deleting a non-current project leaves the current view untouched.
          return { projects: remainingProjects, versionsByProject, chatMessagesByProject, agentTranscripts };
        });

        if (project.folderPath) {
          fetch("/api/projects/folder", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ folderPath: project.folderPath }),
          }).catch(() => {});
        }
      },

      setCurrentProject: (project) => {
        set((state) => {
          const versionsByProject = state.currentProject
            ? { ...state.versionsByProject, [state.currentProject.id]: state.versions }
            : state.versionsByProject;
          const chatMessagesByProject = state.currentProject
            ? { ...state.chatMessagesByProject, [state.currentProject.id]: state.chatMessages }
            : state.chatMessagesByProject;
          return {
            currentProject: project,
            versionsByProject,
            chatMessagesByProject,
            versions: project ? versionsByProject[project.id] ?? [] : [],
            chatMessages: project ? chatMessagesByProject[project.id] ?? [] : [],
          };
        });
      },

      updateFiles: (files, description = "Generated") => {
        const p = get().currentProject;
        if (!p) return;

        if (p.files.length > 0) {
          const snapshot: ProjectVersion = {
            id: nanoid(),
            projectId: p.id,
            files: p.files,
            createdAt: new Date().toISOString(),
            description,
          };
          set((state) => ({
            versions: [snapshot, ...state.versions].slice(0, 10),
          }));
        }

        const updated = { ...p, files, updatedAt: new Date().toISOString() };
        set((state) => ({
          currentProject: updated,
          projects: state.projects.map((pr) => (pr.id === p.id ? updated : pr)),
        }));

        syncFilesToDisk(
          { projectId: p.id, projectName: p.name, files, folderPath: p.folderPath },
          (msg) => set({ syncError: msg }),
          () => set({ syncError: null, lastSyncedAt: new Date().toISOString() })
        );
      },

      mergeFiles: (changedFiles, deletedFiles = [], description = "Updated") => {
        const p = get().currentProject;
        if (!p) return;

        // Snapshot existing state before applying changes
        if (p.files.length > 0) {
          const snapshot: ProjectVersion = {
            id: nanoid(),
            projectId: p.id,
            files: p.files,
            createdAt: new Date().toISOString(),
            description,
          };
          set((state) => ({
            versions: [snapshot, ...state.versions].slice(0, 10),
          }));
        }

        // Merge: start with existing files, apply changes, remove deleted
        const deletedSet = new Set(deletedFiles);
        const changedMap = new Map(changedFiles.map((f) => [f.path, f]));

        const merged: ProjectFile[] = p.files
          // Remove deleted files
          .filter((f) => !deletedSet.has(f.path))
          // Apply changes to existing files
          .map((f) => changedMap.has(f.path) ? changedMap.get(f.path)! : f);

        // Add brand-new files (those in changedFiles that weren't in existing)
        const existingPaths = new Set(p.files.map((f) => f.path));
        changedMap.forEach((file, path) => {
          if (!existingPaths.has(path)) merged.push(file);
        });

        const updated = { ...p, files: merged, updatedAt: new Date().toISOString() };
        set((state) => ({
          currentProject: updated,
          projects: state.projects.map((pr) => (pr.id === p.id ? updated : pr)),
        }));

        // Sync to disk
        syncFilesToDisk(
          { projectId: p.id, projectName: p.name, files: merged, folderPath: p.folderPath },
          (msg) => set({ syncError: msg }),
          () => set({ syncError: null, lastSyncedAt: new Date().toISOString() })
        );
      },

      snapshotCurrentFiles: (description = "Pre-agent snapshot") => {
        const p = get().currentProject;
        if (!p || p.files.length === 0) return;
        const snapshot: ProjectVersion = {
          id: nanoid(),
          projectId: p.id,
          files: p.files,
          createdAt: new Date().toISOString(),
          description,
        };
        set((state) => ({
          versions: [snapshot, ...state.versions].slice(0, 10),
        }));
      },

      updateFileContent: (path, content) => {
        const p = get().currentProject;
        if (!p) return;
        const updatedFiles = p.files.map((f) =>
          f.path === path ? { ...f, content } : f
        );
        const updated = { ...p, files: updatedFiles, updatedAt: new Date().toISOString() };
        set((state) => ({
          currentProject: updated,
          projects: state.projects.map((pr) => (pr.id === p.id ? updated : pr)),
        }));
        // Sync manual edits to disk immediately
        syncFilesToDisk(
          { projectId: p.id, projectName: p.name, files: updatedFiles, folderPath: p.folderPath },
          (msg) => set({ syncError: msg }),
          () => set({ syncError: null, lastSyncedAt: new Date().toISOString() })
        );
      },

      restoreVersion: (version) => {
        const p = get().currentProject;
        if (!p) return;
        const updated = { ...p, files: version.files, updatedAt: new Date().toISOString() };
        set((state) => ({
          currentProject: updated,
          projects: state.projects.map((pr) => (pr.id === p.id ? updated : pr)),
        }));
        // Restore must reach disk too — otherwise the editor shows the rolled-back
        // files while the disk (and the next agent/generate run) keeps the newer
        // ones. (F2)
        syncFilesToDisk(
          { projectId: p.id, projectName: p.name, files: version.files, folderPath: p.folderPath },
          (msg) => set({ syncError: msg }),
          () => set({ syncError: null, lastSyncedAt: new Date().toISOString() })
        );
      },

      addChatMessage: (message) => {
        const msg: ChatMessage = {
          ...message,
          id: nanoid(),
          createdAt: new Date().toISOString(),
        };
        set((state) => ({ chatMessages: [...state.chatMessages, msg] }));
      },

      updateLastAssistantMessage: (content) => {
        set((state) => {
          const msgs = [...state.chatMessages];
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === "assistant") {
              msgs[i] = { ...msgs[i], content };
              return { chatMessages: msgs };
            }
          }
          return {};
        });
      },

      clearChatMessages: () => set({ chatMessages: [] }),

      addPromptTemplate: (template) => {
        const t: PromptTemplate = { ...template, id: nanoid(), isCustom: true };
        set((state) => ({ promptTemplates: [...state.promptTemplates, t] }));
      },

      removePromptTemplate: (id) => {
        set((state) => ({
          promptTemplates: state.promptTemplates.filter((t) => t.id !== id),
        }));
      },

      addGenerationLog: (log) => {
        const entry: GenerationLog = {
          ...log,
          id: nanoid(),
          createdAt: new Date().toISOString(),
        };
        set((state) => ({
          generationLogs: [entry, ...state.generationLogs].slice(0, 500),
        }));
      },
    }),
    {
      name: "gostera-project",
      storage: createJSONStorage(() => idbStorage),
      partialize: (state) => ({
        projects: state.projects,
        currentProject: state.currentProject,
        chatMessages: state.chatMessages,
        promptTemplates: state.promptTemplates,
        versions: state.versions,
        generationLogs: state.generationLogs,
        versionsByProject: state.versionsByProject,
        chatMessagesByProject: state.chatMessagesByProject,
        agentTranscripts: state.agentTranscripts,
      }),
    }
  )
);
