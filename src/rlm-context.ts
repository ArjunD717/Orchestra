import { MemorySearchResult, RepoSummary, WorkflowStep } from "./types";

interface SnapshotState {
  summary: RepoSummary;
  memories: MemorySearchResult[];
  summaryCached: boolean;
  memoryCached: boolean;
}

interface ToolRecord {
  iteration: number;
  signature: string;
  cached: boolean;
  ok: boolean;
  output: string;
}

interface IterationRecord {
  iteration: number;
  summary: string;
  outputPreview: string;
}

interface FailedPathRecord {
  count: number;
  lastError: string;
}

interface ContextBudget {
  total: number;
  repo: number;
  memory: number;
  history: number;
  tools: number;
}

function splitBySize(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) {
    return [text];
  }
  const lines = text.split("\n");
  const out: string[] = [];
  let bucket = "";
  for (const line of lines) {
    if ((bucket + line + "\n").length > maxChars && bucket) {
      out.push(bucket);
      bucket = "";
    }
    bucket += `${line}\n`;
  }
  if (bucket) {
    out.push(bucket);
  }
  return out.length ? out : [text.slice(0, maxChars)];
}

function looksPathLike(input: string): boolean {
  return /[a-z0-9_\-.]+\/[a-z0-9_\-.]/i.test(input) || /\.[a-z0-9]{1,6}\b/i.test(input);
}

export class RLMContextEngine {
  private readonly taskTerms: string[];
  private snapshot: SnapshotState | null = null;
  private readonly toolRecords: ToolRecord[] = [];
  private readonly iterationRecords: IterationRecord[] = [];
  private readonly priorOutputs: string[] = [];
  private readonly seenToolSignatures = new Set<string>();
  private readonly readPaths = new Set<string>();
  private readonly failedPaths = new Map<string, FailedPathRecord>();
  private readonly changedFiles = new Set<string>();

  constructor(
    private readonly runId: string,
    private readonly step: WorkflowStep,
    private readonly task: string
  ) {
    this.taskTerms = task
      .toLowerCase()
      .split(/\s+/g)
      .map((s) => s.trim())
      .filter((s) => s.length >= 3)
      .slice(0, 18);
  }

  setSnapshot(
    summary: RepoSummary,
    memories: MemorySearchResult[],
    summaryCached: boolean,
    memoryCached: boolean
  ): void {
    this.snapshot = { summary, memories, summaryCached, memoryCached };
  }

  rememberReadPath(relPath: string): void {
    if (relPath.trim()) {
      this.readPaths.add(relPath.trim());
    }
  }

  rememberToolSignature(signature: string): void {
    if (signature.trim()) {
      this.seenToolSignatures.add(signature.trim());
    }
  }

  hasSeenToolSignature(signature: string): boolean {
    const normalized = signature.trim();
    if (!normalized) {
      return false;
    }
    return this.seenToolSignatures.has(normalized);
  }

  rememberFailedPath(relPath: string, output: string): void {
    const normalizedPath = relPath.trim() || ".";
    const existing = this.failedPaths.get(normalizedPath);
    const next: FailedPathRecord = {
      count: (existing?.count ?? 0) + 1,
      lastError: output.replace(/\s+/g, " ").trim().slice(0, 240)
    };
    this.failedPaths.set(normalizedPath, next);
    if (this.failedPaths.size > 200) {
      const oldestKey = this.failedPaths.keys().next().value;
      if (typeof oldestKey === "string") {
        this.failedPaths.delete(oldestKey);
      }
    }
  }

  recordToolResult(
    iteration: number,
    signature: string,
    cached: boolean,
    ok: boolean,
    output: string
  ): void {
    this.seenToolSignatures.add(signature);
    this.toolRecords.push({
      iteration,
      signature,
      cached,
      ok,
      output
    });
    if (this.toolRecords.length > 120) {
      this.toolRecords.splice(0, this.toolRecords.length - 90);
    }
  }

  recordIteration(iteration: number, summary: string, fullOutput: string): void {
    this.iterationRecords.push({
      iteration,
      summary: summary.slice(0, 500),
      outputPreview: fullOutput.slice(0, 1200)
    });
    if (this.iterationRecords.length > 40) {
      this.iterationRecords.splice(0, this.iterationRecords.length - 30);
    }
    this.priorOutputs.push(fullOutput.slice(0, 4000));
    if (this.priorOutputs.length > 20) {
      this.priorOutputs.splice(0, this.priorOutputs.length - 12);
    }
  }

  noteDiffApplied(changed: string[]): void {
    for (const file of changed) {
      this.changedFiles.add(file);
    }
  }

  clearFileCachesAfterWrite(): void {
    this.readPaths.clear();
  }

  getPriorOutputs(): string[] {
    return [...this.priorOutputs];
  }

  getRecentToolResults(): string {
    if (this.toolRecords.length === 0) {
      return "";
    }
    return this.toolRecords
      .slice(-15)
      .map((r) => `Tool ${r.signature} cached=${r.cached} ok=${r.ok}\n${r.output}`)
      .join("\n\n");
  }

  private sectionBudgets(maxChars: number): ContextBudget {
    const total = Math.max(8_000, maxChars);
    return {
      total,
      repo: Math.floor(total * 0.4),
      memory: Math.floor(total * 0.18),
      history: Math.floor(total * 0.2),
      tools: Math.floor(total * 0.18)
    };
  }

  private compactChunk(chunk: string): string {
    const lines = chunk
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.trim().length > 0);
    if (lines.length <= 40) {
      return lines.join("\n");
    }

    const picked = new Set<number>();
    for (let i = 0; i < Math.min(4, lines.length); i += 1) {
      picked.add(i);
    }
    for (let i = Math.max(0, lines.length - 4); i < lines.length; i += 1) {
      picked.add(i);
    }

    for (let i = 0; i < lines.length; i += 1) {
      const lower = lines[i].toLowerCase();
      if (this.taskTerms.some((t) => lower.includes(t)) || looksPathLike(lines[i])) {
        picked.add(i);
      }
      if (picked.size > 80) {
        break;
      }
    }

    return [...picked]
      .sort((a, b) => a - b)
      .map((i) => lines[i])
      .join("\n");
  }

  private recursiveCompact(text: string, budget: number, depth = 0): string {
    if (text.length <= budget) {
      return text;
    }
    if (depth >= 3) {
      return text.slice(0, budget);
    }
    const chunks = splitBySize(text, Math.max(1200, Math.floor(budget / 2)));
    const reduced = chunks.map((c) => this.compactChunk(c)).join("\n");
    if (reduced.length >= text.length) {
      return reduced.slice(0, budget);
    }
    return this.recursiveCompact(reduced, budget, depth + 1);
  }

  private renderRepoSection(budget: number): string {
    if (!this.snapshot) {
      return "Repo context: (not available)";
    }
    const parts: string[] = [];
    parts.push(`repoSummaryCached=${this.snapshot.summaryCached}`);
    parts.push(`filesScanned=${this.snapshot.summary.filesScanned}`);
    parts.push("tree:");
    parts.push(this.snapshot.summary.treeLines.slice(0, 200).join("\n"));
    parts.push("keyFiles:");
    parts.push(
      this.snapshot.summary.keyFiles
        .slice(0, 18)
        .map((f) => `FILE ${f.path}\n${f.snippet}`)
        .join("\n\n")
    );
    if (this.changedFiles.size > 0) {
      parts.push(`changedFiles:\n${[...this.changedFiles].slice(-60).join("\n")}`);
    }
    if (this.readPaths.size > 0) {
      parts.push(`alreadyReadPaths:\n${[...this.readPaths].slice(-80).join("\n")}`);
    }
    if (this.failedPaths.size > 0) {
      const failed = [...this.failedPaths.entries()]
        .slice(-80)
        .map(([file, meta]) => `${file} (attempts=${meta.count}) -> ${meta.lastError}`)
        .join("\n");
      parts.push(`failedFilesystemPaths:\n${failed}`);
    }
    return this.recursiveCompact(parts.join("\n\n"), budget);
  }

  private renderMemorySection(budget: number): string {
    if (!this.snapshot) {
      return "Memory context: (not available)";
    }
    const body = [
      `memoryCached=${this.snapshot.memoryCached}`,
      ...this.snapshot.memories
        .slice(0, 20)
        .map((m) => `[${m.scope}] score=${m.score} id=${m.id}\n${m.content}`)
    ].join("\n\n");
    return this.recursiveCompact(body || "No memory hits.", budget);
  }

  private renderHistorySection(budget: number): string {
    const parts = [
      `Run=${this.runId} Step=${this.step.id} Role=${this.step.role}`,
      `Task: ${this.task}`,
      "iterationSummaries:",
      this.iterationRecords
        .slice(-14)
        .map((r) => `i${r.iteration}: ${r.summary}`)
        .join("\n"),
      "priorOutputPreviews:",
      this.iterationRecords
        .slice(-8)
        .map((r) => `i${r.iteration} preview:\n${r.outputPreview}`)
        .join("\n\n")
    ].join("\n\n");
    return this.recursiveCompact(parts, budget);
  }

  private renderToolSection(budget: number): string {
    const pinnedRecent = this.toolRecords
      .slice(-6)
      .map((r) => `i${r.iteration} ${r.signature} cached=${r.cached} ok=${r.ok}\n${r.output.slice(0, 900)}`)
      .join("\n\n");
    const historical = this.toolRecords
      .slice(-24, -6)
      .map((r) => `i${r.iteration} ${r.signature} cached=${r.cached} ok=${r.ok}\n${r.output.slice(0, 300)}`)
      .join("\n\n");
    const signatures = [...this.seenToolSignatures].slice(-120).join("\n") || "(none)";

    const prefix = [
      "pinnedRecentToolResults:",
      pinnedRecent || "(none)",
      "seenToolSignatures:",
      signatures
    ].join("\n\n");
    if (prefix.length >= budget) {
      return prefix.slice(0, budget);
    }

    const remaining = budget - prefix.length - 2;
    const compactedHistorical = historical ? this.recursiveCompact(historical, Math.max(500, remaining)) : "";
    const parts = [prefix, compactedHistorical ? `historicalToolResults:\n${compactedHistorical}` : ""]
      .filter(Boolean)
      .join("\n\n");
    return parts.length <= budget ? parts : parts.slice(0, budget);
  }

  renderPromptContext(maxChars = 40_000): string {
    const budgets = this.sectionBudgets(maxChars);
    const sections = [
      "RLM_CONTEXT_PACKET",
      "=== Repo ===",
      this.renderRepoSection(budgets.repo),
      "=== Memory ===",
      this.renderMemorySection(budgets.memory),
      "=== History ===",
      this.renderHistorySection(budgets.history),
      "=== Tools ===",
      this.renderToolSection(budgets.tools),
      "RULE: Reuse previously observed context. Avoid duplicate filesystem.list/filesystem.read unless files changed.",
      this.failedPaths.size > 0
        ? "RULE: Do not re-request paths listed in failedFilesystemPaths unless the user explicitly says repository files changed."
        : ""
    ];
    return this.recursiveCompact(sections.join("\n\n"), budgets.total);
  }
}
