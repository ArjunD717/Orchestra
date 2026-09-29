import fs from "node:fs/promises";
import { DEFAULT_CONFIG } from "./paths";
import { OrchestraConfig } from "./types";

export async function readConfig(configPath: string): Promise<OrchestraConfig> {
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as OrchestraConfig;
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
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function writeConfig(configPath: string, config: OrchestraConfig): Promise<void> {
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
}

export function addRecentRepo(config: OrchestraConfig, repoPath: string): OrchestraConfig {
  const unique = [repoPath, ...config.recentRepos.filter((r) => r !== repoPath)];
  return {
    ...config,
    recentRepos: unique.slice(0, 12)
  };
}
