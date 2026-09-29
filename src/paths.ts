import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OrchestraConfig } from "./types";
import { ensureBuiltinWorkflowFiles } from "./workflow-catalog";

export interface OrchestraPaths {
  home: string;
  workflowsDir: string;
  memoryDir: string;
  runsDir: string;
  configPath: string;
}

const DEFAULT_CODEX_COMMAND = "codex";
const DEFAULT_CLAUDE_COMMAND = "claude";

export const DEFAULT_CONFIG: OrchestraConfig = {
  safeMode: true,
  recentRepos: [],
  providers: {
    openaiCompatible: {
      baseUrl: "https://api.openai.com/v1"
    },
    openrouter: {
      baseUrl: "https://openrouter.ai/api/v1"
    },
    nim: {
      baseUrl: "https://integrate.api.nvidia.com/v1"
    },
    codexApi: {
      baseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-5.3-codex",
      enabled: true
    },
    codexSubscription: {
      command: DEFAULT_CODEX_COMMAND,
      enabled: true,
      transport: "cli",
      apiBaseUrl: "https://chatgpt.com/backend-api/codex"
    },
    claudeSubscription: {
      command: DEFAULT_CLAUDE_COMMAND,
      enabled: true
    }
  }
};

export function getOrchestraPaths(): OrchestraPaths {
  const home = process.env.ORCHESTRA_HOME?.trim() || path.join(os.homedir(), ".orchestra");
  return {
    home,
    workflowsDir: path.join(home, "workflows"),
    memoryDir: path.join(home, "memory"),
    runsDir: path.join(home, "runs"),
    configPath: path.join(home, "config.json")
  };
}

export const EXAMPLE_WORKFLOW_FILE = "example.yaml";

export const EXAMPLE_WORKFLOW_YAML = `schemaVersion: 1
name: "Default Coding Workflow"
description: "Plan -> logic -> ui -> debug -> review"
steps:
  - id: "plan"
    role: "planner"
    provider: "codex_subscription"
    model: "gpt-5.2"
    reasoningEffort: "medium"
    systemPrompt: |
      You are the planning step. Produce a concise, high-signal implementation plan.
      Keep it actionable and aligned to repository context.
    promptTemplate: |
      You are Orchestra planner.
      Build a short implementation plan for this task:
      {{task}}
    tools: ["filesystem"]
    memory:
      scopes: ["team", "personal"]
      topK: 3
  - id: "logic"
    role: "engineer"
    provider: "codex_subscription"
    model: "gpt-5.3-codex"
    reasoningEffort: "medium"
    systemPrompt: |
      You are the core implementation step.
      Build the actual program logic based on the planner output, repository state, and prior workflow step outputs.
      Do not default to a canned scaffold or fixed file list.
      If the repo is empty, create only the files genuinely required by the current plan.
      If you need more context, emit one or more \`\`\`orchestra_tool JSON blocks and include [CONTINUE].
      Output code changes as a unified diff in a \`\`\`diff fenced block.
      When the planned implementation is complete for this pass, include [STEP_DONE].
    promptTemplate: |
      Implement the core logic and backend behavior for:
      {{task}}
      
      Use the earlier workflow outputs in context, especially the planner output, as the implementation guide.
      Work on the existing project state and move the implementation forward with real code changes.
      Return a unified diff for the files that actually need to change.
    tools: ["filesystem", "git"]
    gate:
      requireApprovalForDiff: true
      requireApprovalForExternalCommands: true
  - id: "ui"
    role: "ui_engineer"
    provider: "codex_subscription"
    model: "gpt-5.3-codex"
    reasoningEffort: "medium"
    systemPrompt: |
      You are the UI implementation step.
      Make real UI changes in the repo instead of writing suggestions or refinement notes.
      Use earlier workflow outputs and the current codebase to implement the interface.
      Output code changes as a unified diff and include [STEP_DONE] when the UI pass is complete.
    promptTemplate: |
      Implement the user-facing UI for:
      {{task}}
      
      Build or improve the actual interface in code. Do not return a proposal document unless the user explicitly asked for one.
    tools: ["filesystem", "git"]
  - id: "debug"
    role: "debugger"
    provider: "codex_subscription"
    model: "gpt-5.2-codex"
    reasoningEffort: "medium"
    systemPrompt: |
      You are the debugging and stabilization step.
      Investigate real defects in the current project, use tests when helpful, and fix the underlying issues.
      Do not only list possible bugs. Make the code better and safer through actual changes when warranted.
      Include [STEP_DONE] when the debugging pass is complete.
    promptTemplate: |
      Debug and stabilize:
      {{task}}
      
      Reproduce or validate issues from the current codebase, then fix them with concrete code changes.
    tools: ["filesystem", "tests"]
    gate:
      requireApprovalForExternalCommands: true
  - id: "review"
    role: "reviewer"
    provider: "codex_subscription"
    model: "gpt-5.2-codex"
    reasoningEffort: "medium"
    systemPrompt: |
      You are the verification and acceptance step.
      Use the tests tool and repository context to verify whether the current implementation is sufficient.
      Prefer actually running a relevant test/verification command before making a final judgment when possible.
      If the project is sufficient, summarize the outcome and end with [STEP_DONE].
      If the project is not sufficient, do not modify files. Instead include a concise planner-facing handoff using:
      REPLAN_MESSAGE: <what the planner should do next>
      and end with [RESTART_WORKFLOW].
    promptTemplate: |
      Verify whether this implementation is good enough for:
      {{task}}
      
      Check the current project state, run verification when possible, and decide whether the workflow should finish or restart from plan with better guidance.
    tools: ["filesystem", "tests"]
`;

export async function ensureOrchestraHome(paths: OrchestraPaths): Promise<void> {
  await fs.mkdir(paths.workflowsDir, { recursive: true });
  await fs.mkdir(path.join(paths.memoryDir, "global"), { recursive: true });
  await fs.mkdir(path.join(paths.memoryDir, "team"), { recursive: true });
  await fs.mkdir(path.join(paths.memoryDir, "personal"), { recursive: true });
  await fs.mkdir(paths.runsDir, { recursive: true });

  try {
    await fs.access(paths.configPath);
  } catch {
    await fs.writeFile(paths.configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf8");
  }

  const files = await fs.readdir(paths.workflowsDir);
  if (files.length === 0) {
    await fs.writeFile(path.join(paths.workflowsDir, EXAMPLE_WORKFLOW_FILE), EXAMPLE_WORKFLOW_YAML, "utf8");
  }
  await ensureBuiltinWorkflowFiles(paths.workflowsDir);
}
