import fs from "node:fs/promises";
import path from "node:path";
import { RepoSummary } from "./types";
import { ensurePathWithinRoot } from "./security";

const DEFAULT_IGNORES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  "out"
]);

interface IgnoreRules {
  exact: Set<string>;
  suffixes: string[];
}

async function loadOrchestraIgnore(repoRoot: string): Promise<IgnoreRules> {
  const file = path.join(repoRoot, ".orchestraignore");
  try {
    const raw = await fs.readFile(file, "utf8");
    const lines = raw
      .split(/\r?\n/g)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
    const exact = new Set<string>();
    const suffixes: string[] = [];
    for (const line of lines) {
      if (line.includes("*")) {
        suffixes.push(line.replace(/\*/g, ""));
      } else {
        exact.add(line);
      }
    }
    return { exact, suffixes };
  } catch {
    return { exact: new Set<string>(), suffixes: [] };
  }
}

function isIgnored(relativePath: string, ignoreRules: IgnoreRules): boolean {
  const parts = relativePath.split(path.sep);
  for (const part of parts) {
    if (DEFAULT_IGNORES.has(part)) {
      return true;
    }
  }
  if (ignoreRules.exact.has(relativePath)) {
    return true;
  }
  return ignoreRules.suffixes.some((s) => relativePath.endsWith(s));
}

function isKeyFile(rel: string): boolean {
  const base = path.basename(rel).toLowerCase();
  return (
    base === "package.json" ||
    base === "tsconfig.json" ||
    base === "readme.md" ||
    base === "orchestra.yaml" ||
    rel.startsWith(`src${path.sep}`) ||
    rel.startsWith(`app${path.sep}`)
  );
}

export async function buildRepoSummary(
  repoRoot: string,
  options: { maxFiles?: number; maxBytes?: number } = {}
): Promise<RepoSummary> {
  const maxFiles = options.maxFiles ?? 200;
  const maxBytes = options.maxBytes ?? 220_000;
  const ignoreRules = await loadOrchestraIgnore(repoRoot);
  const treeLines: string[] = [];
  const keyFiles: Array<{ path: string; snippet: string }> = [];

  let filesScanned = 0;
  let bytesRead = 0;
  let truncated = false;

  async function walk(dir: string): Promise<void> {
    if (truncated) {
      return;
    }
    let entries = await fs.readdir(dir, { withFileTypes: true });
    entries = entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (truncated) {
        return;
      }
      const full = ensurePathWithinRoot(repoRoot, path.join(dir, entry.name));
      const rel = path.relative(repoRoot, full);
      if (isIgnored(rel, ignoreRules)) {
        continue;
      }
      treeLines.push(rel + (entry.isDirectory() ? "/" : ""));
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        filesScanned += 1;
        if (filesScanned >= maxFiles) {
          truncated = true;
          return;
        }
        if (isKeyFile(rel) && keyFiles.length < 12 && bytesRead < maxBytes) {
          const raw = await fs.readFile(full, "utf8").catch(() => "");
          const remaining = Math.max(0, maxBytes - bytesRead);
          const snippet = raw.slice(0, Math.min(remaining, 800));
          bytesRead += Buffer.byteLength(snippet, "utf8");
          keyFiles.push({ path: rel, snippet });
        }
      }
    }
  }

  await walk(repoRoot);
  return { treeLines, keyFiles, truncated, filesScanned, bytesRead };
}
