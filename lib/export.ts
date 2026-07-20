import JSZip from "jszip";
import type { ProjectFile } from "./types";

export async function exportAsZip(
  projectName: string,
  files: ProjectFile[]
): Promise<void> {
  const zip = new JSZip();

  for (const file of files) {
    // Normalize path separators
    const normalizedPath = file.path.replace(/\\/g, "/").replace(/^\//, "");
    zip.file(normalizedPath, file.content);
  }

  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${projectName.replace(/[^a-z0-9]/gi, "-").toLowerCase()}.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
