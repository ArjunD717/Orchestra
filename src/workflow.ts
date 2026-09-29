import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { normalizeWorkflowModels } from "./model-ids";
import { WorkflowDefinition } from "./types";

const voteSchema = z
  .object({
    strategy: z.enum(["best_of_n_same_model", "cross_model_vote", "judge_model"]),
    n: z.number().int().positive().optional(),
    models: z
      .array(
        z.object({
          provider: z.string().min(1),
          model: z.string().min(1)
        })
      )
      .optional(),
    judge: z
      .object({
        provider: z.string().min(1),
        model: z.string().min(1)
      })
      .optional()
  })
  .optional();

const workflowSchema = z.object({
  schemaVersion: z.number().int().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  steps: z.array(
    z.object({
      id: z.string().min(1),
      role: z.string().min(1),
      provider: z.string().min(1),
      model: z.string().min(1),
      reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
      promptTemplate: z.string().min(1),
      systemPrompt: z.string().optional(),
      iterations: z.number().int().positive().optional(),
      tools: z.array(z.string()).default([]),
      voting: voteSchema,
      gate: z
        .object({
          requireApprovalForDiff: z.boolean().optional(),
          requireApprovalForExternalCommands: z.boolean().optional()
        })
        .optional(),
      memory: z
        .object({
          scopes: z.array(z.enum(["global", "team", "personal"])).optional(),
          topK: z.number().int().positive().optional()
        })
        .optional(),
      toolCalls: z
        .array(
          z.object({
            tool: z.enum(["git", "tests", "shell"]),
            command: z.string().min(1)
          })
        )
        .optional()
    })
  )
});

export function parseWorkflowYaml(yamlText: string): WorkflowDefinition {
  const parsed = parse(yamlText);
  const result = workflowSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  return normalizeWorkflowModels(result.data as WorkflowDefinition);
}

export async function listWorkflowFiles(workflowsDir: string): Promise<string[]> {
  const files = await fs.readdir(workflowsDir);
  return files.filter((f) => f.endsWith(".yaml") || f.endsWith(".yml")).sort((a, b) => a.localeCompare(b));
}

export async function loadWorkflowFromFile(workflowsDir: string, fileName: string): Promise<WorkflowDefinition> {
  const fullPath = path.join(workflowsDir, fileName);
  const yamlText = await fs.readFile(fullPath, "utf8");
  return parseWorkflowYaml(yamlText);
}

export async function readWorkflowText(workflowsDir: string, fileName: string): Promise<string> {
  return fs.readFile(path.join(workflowsDir, fileName), "utf8");
}

export async function writeWorkflowText(workflowsDir: string, fileName: string, yamlText: string): Promise<void> {
  parseWorkflowYaml(yamlText);
  await fs.writeFile(path.join(workflowsDir, fileName), yamlText, "utf8");
}
