import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { writeFileAtomic } from "./atomic-write";
import { RunEvent, RunRecord, WorkflowDefinition } from "./types";

export interface RunPaths {
  runId: string;
  createdAt: string;
  runFile: string;
  runDir: string;
  artifactsDir: string;
  metaFile: string;
}

export interface RunMeta extends RunRecord {
  workflow: WorkflowDefinition;
  task?: string;
}

export async function createRunPaths(runsRoot: string): Promise<RunPaths> {
  const createdAt = new Date().toISOString();
  const runId = `${createdAt.replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
  const runFile = path.join(runsRoot, `${runId}.jsonl`);
  const runDir = path.join(runsRoot, runId);
  const artifactsDir = path.join(runDir, "artifacts");
  const metaFile = path.join(runDir, "meta.json");
  await fs.mkdir(artifactsDir, { recursive: true });
  await writeFileAtomic(runFile, "");
  return { runId, createdAt, runFile, runDir, artifactsDir, metaFile };
}

export async function writeRunMeta(
  metaFile: string,
  meta: RunMeta
): Promise<void> {
  await writeFileAtomic(metaFile, JSON.stringify(meta, null, 2));
}

export async function listRuns(runsRoot: string): Promise<string[]> {
  const files = await fs.readdir(runsRoot).catch(() => []);
  return files.filter((f) => f.endsWith(".jsonl")).map((f) => f.replace(/\.jsonl$/, "")).sort().reverse();
}

export async function readRunEvents(runsRoot: string, runId: string): Promise<RunEvent[]> {
  const file = path.join(runsRoot, `${runId}.jsonl`);
  const raw = await fs.readFile(file, "utf8");
  const lines = raw.split(/\r?\n/g).map((line) => line.trim()).filter(Boolean);
  const windowed = lines.length > 10_000 ? lines.slice(lines.length - 10_000) : lines;
  const events: RunEvent[] = [];
  for (const line of windowed) {
    try {
      events.push(JSON.parse(line) as RunEvent);
    } catch {
      // Skip corrupt lines so replay survives partial writes.
    }
  }
  return events;
}

export async function readRunMeta(
  runsRoot: string,
  runId: string
): Promise<RunMeta | null> {
  const file = path.join(runsRoot, runId, "meta.json");
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as RunMeta;
  } catch {
    return null;
  }
}

export async function listArtifacts(runsRoot: string, runId: string): Promise<string[]> {
  const dir = path.join(runsRoot, runId, "artifacts");
  const files = await fs.readdir(dir).catch(() => []);
  return files.map((f) => path.join(dir, f));
}
