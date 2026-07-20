export type Framework =
  | "nextjs"
  | "react-vite"
  | "html-css-js"
  | "node-express"
  | "python-flask"
  | "vuejs"
  | "svelte";

export interface ProjectFile {
  path: string;
  content: string;
}

export interface Project {
  id: string;
  name: string;
  framework: Framework;
  files: ProjectFile[];
  folderPath?: string; // absolute path to the project folder on disk
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  framework: Framework;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectVersion {
  id: string;
  projectId: string;
  files: ProjectFile[];
  createdAt: string;
  description: string;
}

export type MessageRole = "user" | "assistant" | "error";
export type MessageMode = "build" | "discuss";

export interface ChatMessage {
  id: string;
  projectId: string;
  role: MessageRole;
  content: string;
  mode: MessageMode;
  files?: ProjectFile[];
  createdAt: string;
}

export interface GenerationLog {
  id: string;
  projectId: string;
  prompt: string;
  framework: Framework;
  tokensInput: number;
  tokensOutput: number;
  cost: number;
  createdAt: string;
}

export interface UsageStats {
  totalGenerations: number;
  totalTokensInput: number;
  totalTokensOutput: number;
  totalCost: number;
}

export interface PromptTemplate {
  id: string;
  label: string;
  text: string;
  isCustom?: boolean;
}
