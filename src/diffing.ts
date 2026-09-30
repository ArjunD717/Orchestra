import fs from "node:fs/promises";
import path from "node:path";
import { applyPatch, parsePatch } from "diff";
import { ensurePathWithinRoot, sanitizePatchPath } from "./security";

export function extractFirstDiffFence(modelOutput: string): string | null {
  const lines = modelOutput.split(/\r?\n/g);
  let start = -1;

  for (let idx = 0; idx < lines.length; idx += 1) {
    if (lines[idx].trim().match(/^```diff\b/i)) {
      start = idx + 1;
      break;
    }
  }

  if (start < 0) {
    return null;
  }

  for (let idx = start; idx < lines.length; idx += 1) {
    if (lines[idx].trim() === "```") {
      return lines.slice(start, idx).join("\n").trim();
    }
  }

  return lines.slice(start).join("\n").trim() || null;
}

export async function saveDiffArtifact(artifactDir: string, stepId: string, diffText: string): Promise<string> {
  await fs.mkdir(artifactDir, { recursive: true });
  const name = `${stepId}-${Date.now()}.diff`;
  const fullPath = path.join(artifactDir, name);
  await fs.writeFile(fullPath, diffText, "utf8");
  return fullPath;
}

function resolvePatchTarget(repoRoot: string, oldFile: string, newFile: string): { target: string; deleteFile: boolean } {
  const oldSanitized = sanitizePatchPath(oldFile);
  const newSanitized = sanitizePatchPath(newFile);

  if (newSanitized === "/dev/null") {
    const target = ensurePathWithinRoot(repoRoot, path.join(repoRoot, oldSanitized));
    return { target, deleteFile: true };
  }
  const target = ensurePathWithinRoot(repoRoot, path.join(repoRoot, newSanitized));
  return { target, deleteFile: false };
}

export async function applyUnifiedDiff(repoRoot: string, diffText: string): Promise<string[]> {
  const patches = parsePatch(diffText);
  const changedFiles: string[] = [];
  const resolved: Array<{ target: string; deleteFile: boolean; original: string; isNew: boolean }> = [];

  // Phase 1: resolve all targets (traversal throws propagate) and read originals.
  for (const patch of patches) {
    const oldName = patch.oldFileName ?? "";
    const newName = patch.newFileName ?? "";
    const { target, deleteFile } = resolvePatchTarget(repoRoot, oldName, newName);
    const rel = path.relative(repoRoot, target);
    let original: string;
    let isNew = false;
    try {
      original = await fs.readFile(target, "utf8");
    } catch {
      const isNewFile = oldName.trim() === "/dev/null" || oldName.trim() === "dev/null";
      if (deleteFile || !isNewFile) {
        throw new Error(`Patch target does not exist: ${rel}`);
      }
      original = "";
      isNew = true;
    }
    resolved.push({ target, deleteFile, original, isNew });
  }

  // Phase 2: apply in memory, then write; on ANY failure restore backups then rethrow.
  const pending: Array<{ target: string; deleteFile: boolean; next: string }> = [];
  try {
    for (let idx = 0; idx < patches.length; idx += 1) {
      const item = resolved[idx];
      const rel = path.relative(repoRoot, item.target);
      if (item.deleteFile) {
        pending.push({ target: item.target, deleteFile: true, next: "" });
        continue;
      }
      const applied = applyPatch(item.original, patches[idx], { fuzzFactor: 0 });
      if (applied === false) {
        throw new Error(`Patch failed for ${rel}`);
      }
      pending.push({ target: item.target, deleteFile: false, next: applied as string });
    }
    for (const item of pending) {
      if (item.deleteFile) {
        await fs.rm(item.target, { force: true });
      } else {
        await fs.mkdir(path.dirname(item.target), { recursive: true });
        await fs.writeFile(item.target, item.next, "utf8");
      }
      changedFiles.push(path.relative(repoRoot, item.target));
    }
  } catch (error) {
    for (const item of resolved) {
      try {
        if (item.isNew) {
          await fs.rm(item.target, { force: true });
        } else {
          await fs.mkdir(path.dirname(item.target), { recursive: true });
          await fs.writeFile(item.target, item.original, "utf8");
        }
      } catch {
        // Best-effort rollback; surface the original failure.
      }
    }
    throw error;
  }

  return changedFiles;
}

export function summarizeDiff(diffText: string): { files: string[]; additions: number; deletions: number } {
  const files: string[] = [];
  let additions = 0;
  let deletions = 0;
  const lines = diffText.split(/\r?\n/g);
  for (const line of lines) {
    if (line.startsWith("+++ ")) {
      try {
        files.push(sanitizePatchPath(line.slice(4).trim()));
      } catch {
        files.push(line.slice(4).trim());
      }
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      additions += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions += 1;
    }
  }
  return { files, additions, deletions };
}
