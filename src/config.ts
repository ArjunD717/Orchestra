import fs from "node:fs/promises";
import { writeFileAtomic } from "./atomic-write";
import { DEFAULT_CONFIG } from "./paths";
import { OrchestraConfig } from "./types";

export async function readConfig(configPath: string): Promise<OrchestraConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch {
    return { ...DEFAULT_CONFIG };
  }
  let parsed: OrchestraConfig;
  try {
    parsed = JSON.parse(raw) as OrchestraConfig;
  } catch (err) {
    const backupPath = `${configPath}.corrupt-${Date.now()}.bak`;
    try {
      await fs.writeFile(backupPath, raw, "utf8");
    } catch {
      // Best effort: the important part is not losing the user's file.
    }
    console.error(
      `[orchestra] Config at ${configPath} is not valid JSON (${err instanceof Error ? err.message : String(err)}). ` +
        `Backed up to ${backupPath} and continuing with defaults.`
    );
    return { ...DEFAULT_CONFIG };
  }
  const defaults = DEFAULT_CONFIG.providers;
  const incoming = parsed.providers ?? {};
  const merged: OrchestraConfig = {
    ...DEFAULT_CONFIG,
    ...parsed,
    providers: {
      ...defaults,
      ...incoming,
      openaiCompatible: { ...defaults.openaiCompatible, ...incoming.openaiCompatible },
      openrouter: { ...defaults.openrouter, ...incoming.openrouter },
      nim: { ...defaults.nim, ...incoming.nim },
      codexApi: { ...defaults.codexApi, ...incoming.codexApi },
      codexSubscription: { ...defaults.codexSubscription, ...incoming.codexSubscription },
      claudeSubscription: { ...defaults.claudeSubscription, ...incoming.claudeSubscription }
    },
    recentRepos: Array.isArray(parsed.recentRepos) ? parsed.recentRepos : []
  };
  if (process.platform === "win32") {
    if (merged.providers.codexSubscription?.command?.trim().toLowerCase() === "codex.cmd") {
      merged.providers.codexSubscription.command = "codex";
    }
    if (merged.providers.claudeSubscription?.command?.trim().toLowerCase() === "claude.cmd") {
      merged.providers.claudeSubscription.command = "claude";
    }
  }
  return merged;
}

export async function writeConfig(configPath: string, config: OrchestraConfig): Promise<void> {
  await writeFileAtomic(configPath, JSON.stringify(config, null, 2));
  if (process.platform !== "win32") {
    try {
      await fs.chmod(configPath, 0o600);
    } catch {
      // Best effort: permissions hardening must not fail the write.
    }
  }
}

export function addRecentRepo(config: OrchestraConfig, repoPath: string): OrchestraConfig {
  const unique = [repoPath, ...config.recentRepos.filter((r) => r !== repoPath)];
  return {
    ...config,
    recentRepos: unique.slice(0, 12)
  };
}
