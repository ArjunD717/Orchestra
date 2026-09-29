import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { MemoryItem, MemoryScope, MemorySearchResult } from "./types";

const MAX_MEMORY_CONTENT_CHARS = 8_000;

const memoryItemSchema = z.object({
  id: z.string().min(1),
  scope: z.enum(["global", "team", "personal"]),
  tags: z.array(z.string()).optional(),
  createdAt: z.string().min(1),
  content: z.string()
});

function scopeDir(memoryRoot: string, scope: MemoryScope): string {
  return path.join(memoryRoot, scope);
}

export async function addMemoryItem(
  memoryRoot: string,
  scope: MemoryScope,
  content: string,
  tags: string[] = []
): Promise<MemoryItem> {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error("Memory content must not be empty.");
  }
  if (trimmed.length > MAX_MEMORY_CONTENT_CHARS) {
    throw new Error(`Memory content exceeds ${MAX_MEMORY_CONTENT_CHARS} characters.`);
  }
  const item: MemoryItem = {
    id: crypto.randomUUID(),
    scope,
    createdAt: new Date().toISOString(),
    tags: tags.filter(Boolean),
    content: trimmed
  };
  const filePath = path.join(scopeDir(memoryRoot, scope), `${item.id}.json`);
  await fs.writeFile(filePath, JSON.stringify(item, null, 2), "utf8");
  return item;
}

export async function listMemoryByScope(memoryRoot: string, scope: MemoryScope): Promise<MemoryItem[]> {
  const dir = scopeDir(memoryRoot, scope);
  const files = await fs.readdir(dir);
  const items: MemoryItem[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) {
      continue;
    }
    let raw: string;
    try {
      raw = await fs.readFile(path.join(dir, file), "utf8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const result = memoryItemSchema.safeParse(parsed);
    if (!result.success || result.data.scope !== scope) {
      continue;
    }
    items.push({ ...result.data, tags: result.data.tags ?? [] });
  }
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function scoreContent(queryTerms: string[], content: string, tags?: string[]): number {
  const haystack = `${content}\n${(tags ?? []).join(" ")}`.toLowerCase();
  let score = 0;
  for (const term of queryTerms) {
    if (term.length < 2) {
      continue;
    }
    const hits = haystack.split(term).length - 1;
    score += hits * (term.length >= 6 ? 2 : 1);
  }
  return score;
}

export async function searchMemory(
  memoryRoot: string,
  query: string,
  scopes: MemoryScope[],
  topK = 5
): Promise<MemorySearchResult[]> {
  const terms = query
    .toLowerCase()
    .split(/\s+/g)
    .map((s) => s.trim())
    .filter(Boolean);
  const results: MemorySearchResult[] = [];

  for (const scope of scopes) {
    const items = await listMemoryByScope(memoryRoot, scope);
    for (const item of items) {
      const score = scoreContent(terms, item.content, item.tags);
      if (score <= 0) {
        continue;
      }
      results.push({
        ...item,
        score,
        sourcePath: path.join(scopeDir(memoryRoot, scope), `${item.id}.json`)
      });
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, topK);
}
