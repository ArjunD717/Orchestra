import path from "node:path";
import { EventLogWriter } from "./event-log";
import { searchMemory } from "./memory";
import { normalizeModelForProvider } from "./model-ids";
import { consumeProviderTrace, createProviderRegistry } from "./providers";
import { buildRepoSummary } from "./repo";
import { createRunPaths, writeRunMeta } from "./run-store";
import {
  CandidateResult,
  MemorySearchResult,
  RepoSummary,
  OrchestraConfig,
  RunEvent,
  RunResult,
  RunnerUiHooks,
  WorkflowDefinition,
  WorkflowStep
} from "./types";
import { extractFirstDiffFence, saveDiffArtifact, summarizeDiff, applyUnifiedDiff } from "./diffing";
import { FilesystemTool, GitTool, ShellTool, TestsTool, ToolContext } from "./tools";
import { RLMContextEngine } from "./rlm-context";

interface RunRequest {
  runsRoot: string;
  memoryRoot: string;
  repoPath: string;
  workflow: WorkflowDefinition;
  task: string;
  safeMode: boolean;
  ui: RunnerUiHooks;
  providerConfig: OrchestraConfig["providers"];
}

function nowIso(): string {
  return new Date().toISOString();
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replace(new RegExp(`{{\\s*${k}\\s*}}`, "g"), v);
  }
  return out;
}

function toEvent(runId: string, stepId: string | null, type: RunEvent["type"], data: Record<string, unknown>): RunEvent {
  return {
    ts: nowIso(),
    runId,
    stepId,
    type,
    data
  };
}

const BASE_STEP_SYSTEM_PROMPT = [
  "You are Orchestra, a local-first coding agent step executor.",
  "Stay within repository context and produce practical outputs for this step role.",
  "Never dump full file rewrites or standalone source code blocks unless explicitly asked by the user.",
  "Exception: it is OK to include full contents for NEW files when creating them via unified diff.",
  "Writing policy: Orchestra can only write to the repo by applying unified diffs you output inside a ```diff fenced block.",
  "",
  "Tool policy:",
  "- Only request tools that are enabled for this step (listed below). Disabled tools will be denied.",
  "- Request tools ONLY when you need information not already present in the repo summary/context packet.",
  "- Tool calls are NOT required every iteration. Do not call tools 'to satisfy a requirement'.",
  "- If the repo appears empty (0 files), avoid repetitive probing. After at most one filesystem.list of '.', either propose an initial implementation diff or finish with a concise plan if code changes are not yet justified.",
  "",
  "Tool request protocol:",
  "- Request tools using ```orchestra_tool JSON blocks. You may include multiple blocks.",
  "- If you request tools, stop after the tool block(s). Do not add a [CONTINUE] marker.",
  'Example: ```orchestra_tool {"tool":"filesystem.read","path":"src/index.ts"} ```',
  "Supported tool names (if enabled): filesystem.read, filesystem.list, git, tests, shell.",
  "",
  "For code changes, output ONLY unified diffs in a ```diff fenced block.",
  "To create a new file in a diff, use: --- /dev/null and +++ b/<path>.",
  "Prefer diffs that are likely to apply cleanly, but choose whatever scope best fits the task. You may create, modify, or remove any files that are actually needed.",
  "Output format (required):",
  "1) The FIRST LINE must be: Summary: <one concise sentence of what you did this iteration>.",
  "2) If you request tools, include tool blocks after the Summary line.",
  "3) If the step is complete, the FINAL LINE must be [STEP_DONE]. Review steps may also use [RESTART_WORKFLOW] when explicitly instructed.",
  "Never place [STEP_DONE]/[RESTART_WORKFLOW] before tool request blocks.",
  "Do not invent tools, and do not assume external command execution unless approved.",
  "Tool requests already imply another iteration. Only emit [STEP_DONE] when the step is actually complete."
].join("\n");

const MAX_MODEL_TOOL_CALLS_PER_ITERATION = 5;

const RUN_WALL_CLOCK_MS = (() => {
  const parsed = Number.parseInt(process.env.ORCHESTRA_RUN_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30 * 60 * 1000;
})();

interface ParsedToolRequest {
  tool: string;
  command?: string;
  path?: string;
  cwd?: string;
}

interface ParsedToolCallSet {
  requests: ParsedToolRequest[];
  parseErrors: string[];
}

interface ExecutedToolResult {
  request: ParsedToolRequest;
  ok: boolean;
  output: string;
  cached: boolean;
}

interface LoopAction {
  source: "model" | "provider";
  tool: string;
  command?: string;
  path?: string;
  ok?: boolean;
  output?: string;
  cached?: boolean;
  exitCode?: number | null;
  status?: string;
}

interface ExecutedActionBatch {
  results: ExecutedToolResult[];
  interruptedPrompts: string[];
  interruptedActionSummary?: string;
}

interface CompletedStepOutput {
  stepId: string;
  role: string;
  summary: string;
  output: string;
}

function parseToolRequestObject(candidate: unknown, parseErrors: string[]): ParsedToolRequest | null {
  if (!candidate || typeof candidate !== "object") {
    parseErrors.push("Tool request item must be an object.");
    return null;
  }
  const rec = candidate as Record<string, unknown>;
  const tool =
    typeof rec.tool === "string"
      ? rec.tool.trim()
      : typeof rec.tool_name === "string"
        ? rec.tool_name.trim()
        : typeof rec.name === "string"
          ? rec.name.trim()
          : "";
  if (!tool) {
    parseErrors.push("Tool request is missing a string 'tool' field.");
    return null;
  }
  const args = rec.arguments && typeof rec.arguments === "object" ? (rec.arguments as Record<string, unknown>) : null;
  const commandFromArgs = args && typeof args.command === "string" ? args.command : undefined;
  const pathFromArgs = args && typeof args.path === "string" ? args.path : undefined;
  const cwdFromArgs = args && typeof args.cwd === "string" ? args.cwd : undefined;
  return {
    tool,
    command: typeof rec.command === "string" ? rec.command : commandFromArgs,
    path: typeof rec.path === "string" ? rec.path : pathFromArgs,
    cwd: typeof rec.cwd === "string" ? rec.cwd : cwdFromArgs
  };
}

function parseKeyValueTokens(rest: string): Record<string, string> {
  const out: Record<string, string> = {};
  const matcher = /([a-zA-Z_][a-zA-Z0-9_]*)=("([^"]*)"|'([^']*)'|[^\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(rest)) !== null) {
    const key = match[1];
    const raw = match[2];
    if (!raw) {
      continue;
    }
    const unquoted =
      (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
        ? raw.slice(1, -1)
        : raw;
    out[key] = unquoted;
  }
  return out;
}

function parseModelToolRequests(text: string): ParsedToolCallSet {
  const requests: ParsedToolRequest[] = [];
  const parseErrors: string[] = [];
  const dedupe = new Set<string>();

  const addRequest = (req: ParsedToolRequest | null): void => {
    if (!req) {
      return;
    }
    const key = JSON.stringify(req);
    if (dedupe.has(key)) {
      return;
    }
    dedupe.add(key);
    requests.push(req);
  };

  const jsonBlocks = [...text.matchAll(/```orchestra_tool\s*([\s\S]*?)```/gi)];
  const genericJsonBlocks = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)];
  const xmlBlocks = [...text.matchAll(/<orchestra_tool>([\s\S]*?)<\/orchestra_tool>/gi)];
  const allBlocks = [...jsonBlocks, ...genericJsonBlocks, ...xmlBlocks];

  for (const block of allBlocks) {
    const raw = block[1]?.trim();
    if (!raw) {
      continue;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      for (const candidate of candidates) {
        addRequest(parseToolRequestObject(candidate, parseErrors));
      }
    } catch (error) {
      parseErrors.push(error instanceof Error ? error.message : String(error));
    }
  }

  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.includes('"tool"')) {
    try {
      const maybe = JSON.parse(trimmed) as unknown;
      addRequest(parseToolRequestObject(maybe, parseErrors));
    } catch {
      // ignore non-JSON bodies that only start with "{"
    }
  }

  for (const line of text.split(/\r?\n/g)) {
    const m = line.match(/^\s*TOOL\s+([a-zA-Z0-9._-]+)\s*(.*)$/i);
    if (!m) {
      continue;
    }
    const tool = m[1].trim();
    const rest = (m[2] ?? "").trim();
    const kv = parseKeyValueTokens(rest);
    const req: ParsedToolRequest = {
      tool,
      command: kv.command,
      path: kv.path,
      cwd: kv.cwd
    };
    if (!req.command && (tool === "git" || tool === "tests" || tool === "shell") && rest) {
      req.command = rest;
    }
    addRequest(req);
  }

  return { requests, parseErrors };
}

function normalizeToolName(input: string): string {
  return input.trim().toLowerCase();
}

function summarizeModelOutput(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "(empty model output)";
  }
  return normalized.slice(0, 280);
}

function normalizedControlPrefix(line: string): string {
  return line
    .replace(/^[\s>*`#\-+]+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function isIterationSummaryLine(line: string): boolean {
  const normalized = normalizedControlPrefix(line);
  return (
    normalized.startsWith("SUMMARY:") ||
    normalized.startsWith("ITERATION_SUMMARY:") ||
    normalized.startsWith("ITERATION SUMMARY:")
  );
}

function normalizeSignalToken(raw: string): "[CONTINUE]" | "[STEP_DONE]" | "[RESTART_WORKFLOW]" | null {
  const token = raw
    .replace(/^[\s>*`#\-+]+/, "")
    .replace(/\s+/g, "")
    .trim()
    .toUpperCase();
  if (!token) {
    return null;
  }
  if (token === "[CONTINUE]" || token === "<CONTINUE>" || token === "CONTINUE_ITERATION" || token === "CONTINUE") {
    return "[CONTINUE]";
  }
  if (token === "[STEP_DONE]" || token === "<STEP_DONE>" || token === "STEP_DONE") {
    return "[STEP_DONE]";
  }
  if (token === "[RESTART_WORKFLOW]" || token === "<RESTART_WORKFLOW>" || token === "RESTART_WORKFLOW") {
    return "[RESTART_WORKFLOW]";
  }
  return null;
}

function stripInlineControlMarkers(line: string): string {
  // Remove standalone control markers that sometimes get embedded inline.
  // We only strip bracket/angle variants to avoid touching normal words.
  return line
    .replace(/(^|\s)(?:\[(?:CONTINUE|STEP_DONE|RESTART_WORKFLOW)\]|<(?:continue|step_done|restart_workflow)>)(?=\s|$)/gi, "$1")
    .replace(/\s{2,}/g, " ");
}

function extractIterationSummary(text: string): string | null {
  let best: string | null = null;
  for (const rawLine of text.replace(/\r\n/g, "\n").split("\n")) {
    if (!isIterationSummaryLine(rawLine)) {
      continue;
    }
    const cleaned = rawLine.replace(/^[\s>*`#\-+]+/, "");
    const idx = cleaned.indexOf(":");
    const rest = (idx >= 0 ? cleaned.slice(idx + 1) : cleaned).replace(/\s+/g, " ").trim();
    if (rest) {
      best = rest.slice(0, 500);
    }
  }
  if (best) {
    return best;
  }
  const block = text.match(/\[ITERATION_SUMMARY\]([\s\S]*?)\[\/ITERATION_SUMMARY\]/i);
  if (block?.[1]?.trim()) {
    return block[1].replace(/\s+/g, " ").trim().slice(0, 500);
  }
  return null;
}

function detectFinalSignal(text: string): "[CONTINUE]" | "[STEP_DONE]" | "[RESTART_WORKFLOW]" | null {
  let last: "[CONTINUE]" | "[STEP_DONE]" | "[RESTART_WORKFLOW]" | null = null;
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const normalized = normalizeSignalToken(line);
    if (normalized) {
      last = normalized;
    }
  }
  return last;
}

function normalizeIterationOutput(text: string): string {
  const normalizedNewlines = text
    .replace(/\r\n/g, "\n")
    .replace(/(\[CONTINUE\]|\[STEP_DONE\]|\[RESTART_WORKFLOW\])(?=Summary:)/gi, "$1\nSummary:");
  const summarySource = extractIterationSummary(normalizedNewlines);
  const withoutSummaryBlocks = normalizedNewlines.replace(/\[ITERATION_SUMMARY\][\s\S]*?\[\/ITERATION_SUMMARY\]/gi, "");
  const lines = withoutSummaryBlocks.split("\n");
  const cleanedLines: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      inFence = !inFence;
      cleanedLines.push(line);
      continue;
    }
    if (!inFence && (isIterationSummaryLine(line) || normalizeSignalToken(line))) {
      continue;
    }
    cleanedLines.push(inFence ? line : stripInlineControlMarkers(line));
  }
  const body = cleanedLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const inferredSummary = summarySource ?? summarizeModelOutput(body || normalizedNewlines);
  const summary = inferredSummary.replace(/\s+/g, " ").trim().slice(0, 500);
  const parsedTools = parseModelToolRequests(normalizedNewlines);
  const detectedSignal = detectFinalSignal(normalizedNewlines);
  const signal =
    detectedSignal === "[STEP_DONE]" || detectedSignal === "[RESTART_WORKFLOW]" || /\[RESTART_WORKFLOW\]/i.test(normalizedNewlines)
      ? detectedSignal
      : null;
  const outLines: string[] = [];
  outLines.push(`Summary: ${summary}`);
  if (body) {
    outLines.push("");
    outLines.push(body);
  }
  if (signal === "[STEP_DONE]") {
    outLines.push(signal);
  } else if (signal === "[RESTART_WORKFLOW]" || /\[RESTART_WORKFLOW\]/i.test(normalizedNewlines)) {
    outLines.push("[RESTART_WORKFLOW]");
  } else if (parsedTools.requests.length === 0) {
    outLines.push("[STEP_DONE]");
  }
  return `${outLines.join("\n")}\n`;
}

function toolCacheKey(tool: string, command: string, relPath: string): string {
  return `${tool}|${command}|${relPath}`;
}

function normalizeRelativePath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed || trimmed === ".") {
    return ".";
  }
  const slash = trimmed.replace(/\\/g, "/");
  const normalized = path.posix.normalize(slash);
  const withoutCurrent = normalized.replace(/^\.\/+/, "");
  const stripped = withoutCurrent.endsWith("/") && withoutCurrent.length > 1 ? withoutCurrent.slice(0, -1) : withoutCurrent;
  if (!stripped || stripped === ".") {
    return ".";
  }
  return stripped;
}

function isFilesystemToolName(tool: string): boolean {
  const normalized = normalizeToolName(tool);
  return normalized === "filesystem.read" || normalized === "filesystem.list";
}

function isFilesystemRequest(req: ParsedToolRequest): boolean {
  return isFilesystemToolName(req.tool);
}

function isLikelyPathProbeError(output: string): boolean {
  return /ENOENT|ENOTDIR|EISDIR|no such file or directory|not found|illegal operation on a directory|is a directory/i.test(
    output
  );
}

function repoHasImplementationFiles(summary: RepoSummary): boolean {
  const files = summary.treeLines.filter((l) => l && !l.endsWith("/"));
  for (const file of files) {
    const lower = file.toLowerCase();
    if (lower === "package.json" || lower === "index.html") {
      return true;
    }
    if (lower.startsWith("src/") || lower.startsWith("app/")) {
      return true;
    }
    if (/\.(ts|tsx|js|jsx|html|css)$/i.test(lower)) {
      return true;
    }
  }
  return false;
}

function requestSignature(req: ParsedToolRequest): string {
  const normalizedPath = req.path ? normalizeRelativePath(req.path) : "";
  const normalizedCommand = (req.command ?? "").trim().replace(/\s+/g, " ");
  return `${normalizeToolName(req.tool)}|${normalizedPath}|${normalizedCommand}`;
}

function summarizeLoopActions(actions: LoopAction[], maxItems = 6): string {
  if (actions.length === 0) {
    return "";
  }
  return actions
    .slice(0, maxItems)
    .map((action, idx) => {
      const detail = action.command?.trim() || action.path?.trim() || "";
      const suffix = detail ? ` ${detail}` : "";
      const outcome =
        typeof action.ok === "boolean"
          ? ` ok=${action.ok}${action.cached ? " cached=true" : ""}`
          : action.status
            ? ` status=${action.status}`
            : "";
      return `${idx + 1}. [${action.source}] ${action.tool}${suffix}${outcome}`;
    })
    .join("\n");
}

function buildLoopActions(
  requests: ParsedToolRequest[],
  providerToolCalls: Array<{
    tool: string;
    command: string;
    output: string;
    ok: boolean;
    exitCode?: number | null;
    status?: string;
    source: string;
  }>
): LoopAction[] {
  const modelActions: LoopAction[] = requests.map((req) => ({
    source: "model",
    tool: normalizeToolName(req.tool),
    command: req.command,
    path: req.path
  }));
  const providerActions: LoopAction[] = providerToolCalls.map((call) => ({
    source: "provider",
    tool: call.tool,
    command: call.command,
    ok: call.ok,
    output: call.output,
    exitCode: call.exitCode ?? null,
    status: call.status ?? "completed"
  }));
  return [...modelActions, ...providerActions];
}

async function consumeQueuedPromptsAtCheckpoint(
  runId: string,
  stepId: string,
  iteration: number,
  phase: string,
  ui: RunnerUiHooks,
  append: (event: RunEvent) => Promise<void>
): Promise<string[]> {
  const prompts = ui.consumePendingUserPrompts?.() ?? [];
  if (prompts.length === 0) {
    return [];
  }
  ui.log(`[${stepId} i${iteration}] pausing for ${prompts.length} new user prompt(s) at ${phase}.`);
  await append(
    toEvent(runId, stepId, "user_prompt_injected", {
      iteration,
      phase,
      count: prompts.length,
      prompts: prompts.map((p) => p.slice(0, 2000))
    })
  );
  return prompts;
}

function buildDiffRepairContext(stepId: string, iteration: number, diffText: string, errorMessage: string): string {
  const diffSummary = summarizeDiff(diffText);
  const excerpt = diffText.split(/\r?\n/g).slice(0, 80).join("\n");
  return [
    `Diff repair needed for step "${stepId}" iteration ${iteration}.`,
    `Patch application failed with: ${errorMessage}`,
    `Files: ${diffSummary.files.join(", ") || "(unknown)"}`,
    `Additions: ${diffSummary.additions}  Deletions: ${diffSummary.deletions}`,
    "Repair the patch against the CURRENT repo state.",
    "Return ONLY a corrected unified diff if changes are still needed.",
    `Prior diff excerpt:\n${excerpt}`
  ].join("\n\n");
}

function renderPriorWorkflowOutputs(outputs: CompletedStepOutput[], currentStepId: string): string {
  const prior = outputs.filter((output) => output.stepId !== currentStepId);
  if (prior.length === 0) {
    return "";
  }
  return prior
    .map((output, index) =>
      [
        `${index + 1}. Step "${output.stepId}" (${output.role})`,
        `Summary: ${output.summary}`,
        output.output.slice(0, 2400)
      ].join("\n")
    )
    .join("\n\n");
}

function buildWorkflowTask(baseTask: string, reviewFeedbackHistory: string[]): string {
  if (reviewFeedbackHistory.length === 0) {
    return baseTask;
  }
  return [
    baseTask,
    "Review feedback from earlier workflow pass(es):",
    reviewFeedbackHistory.map((feedback, index) => `${index + 1}. ${feedback}`).join("\n"),
    "Iterate on the existing project state. Do not restart from scratch unless the feedback explicitly requires it."
  ].join("\n\n");
}

function extractWorkflowRestartMessage(text: string): string | null {
  const match = text.match(/REPLAN_MESSAGE:\s*([\s\S]*?)(?:\n\[[A-Z_]+\]|$)/i);
  const message = match?.[1]?.trim();
  return message ? message.slice(0, 4000) : null;
}

function extractTemporaryWorkflow(text: string): WorkflowDefinition | null {
  const blockMatch = text.match(/```orchestra_workflow\s*([\s\S]*?)```/i);
  const raw = blockMatch?.[1]?.trim();
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const stepsRaw = Array.isArray(parsed.steps) ? parsed.steps : [];
    const steps: WorkflowStep[] = [];
    for (const entry of stepsRaw) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const id = String(record.id ?? "").trim();
      const role = String(record.role ?? "").trim();
      const provider = String(record.provider ?? "").trim();
      const model = String(record.model ?? "").trim();
      const promptTemplate = String(record.promptTemplate ?? "").trim();
      const tools = Array.isArray(record.tools)
        ? record.tools.map((tool) => String(tool).trim()).filter(Boolean)
        : [];
      if (!id || !role || !provider || !model || !promptTemplate) {
        continue;
      }
      const step: WorkflowStep = {
        id,
        role,
        provider,
        model,
        promptTemplate,
        tools
      };
      if (typeof record.reasoningEffort === "string" && record.reasoningEffort.trim()) {
        step.reasoningEffort = record.reasoningEffort as WorkflowStep["reasoningEffort"];
      }
      if (typeof record.systemPrompt === "string" && record.systemPrompt.trim()) {
        step.systemPrompt = record.systemPrompt.trim();
      }
      if (typeof record.iterations === "number" && Number.isFinite(record.iterations) && record.iterations > 0) {
        step.iterations = Math.floor(record.iterations);
      }
      if (record.gate && typeof record.gate === "object") {
        const gate = record.gate as Record<string, unknown>;
        step.gate = {
          requireApprovalForDiff: Boolean(gate.requireApprovalForDiff),
          requireApprovalForExternalCommands: Boolean(gate.requireApprovalForExternalCommands)
        };
      }
      steps.push(step);
    }
    if (steps.length === 0) {
      return null;
    }
    return {
      schemaVersion:
        typeof parsed.schemaVersion === "number" && Number.isFinite(parsed.schemaVersion)
          ? parsed.schemaVersion
          : 1,
      name: String(parsed.name ?? "Review follow-up workflow").trim() || "Review follow-up workflow",
      description:
        typeof parsed.description === "string" && parsed.description.trim() ? parsed.description.trim() : undefined,
      steps
    };
  } catch {
    return null;
  }
}

function createRestartWorkflow(
  workflow: WorkflowDefinition,
  restartMessage: string,
  workflowPass: number,
  temporaryWorkflow?: WorkflowDefinition | null
): WorkflowDefinition {
  const sourceWorkflow = temporaryWorkflow ?? workflow;
  const cloned: WorkflowDefinition = JSON.parse(JSON.stringify(sourceWorkflow)) as WorkflowDefinition;
  const firstStep = cloned.steps[0];
  if (!firstStep) {
    return cloned;
  }
  const injectedInstruction = [
    `Review-triggered follow-up workflow pass ${workflowPass + 1}.`,
    "The previous review step determined the implementation was not sufficient.",
    `Address this issue first:\n${restartMessage}`,
    "Produce an updated plan that directly resolves the review feedback while iterating on the existing project."
  ].join("\n\n");
  firstStep.systemPrompt = [firstStep.systemPrompt?.trim() ?? "", injectedInstruction].filter(Boolean).join("\n\n");
  firstStep.promptTemplate = `${injectedInstruction}\n\n${firstStep.promptTemplate}`;
  cloned.name = `${sourceWorkflow.name} [follow-up ${workflowPass + 1}]`;
  cloned.description = [sourceWorkflow.description ?? "", `Follow-up workflow generated from review feedback.`]
    .filter(Boolean)
    .join(" ");
  return cloned;
}

interface RlmDecision {
  decision: "decompose" | "execute" | "done";
  subgoals: string[];
  reason: string;
  summary?: string;
}

function tryParseDecisionJson(text: string): RlmDecision | null {
  const block = text.match(/```json\s*([\s\S]*?)```/i);
  const body = (block?.[1] ?? text).trim();
  if (!body.startsWith("{")) {
    return null;
  }
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const rawDecision = String(parsed.decision ?? "").toLowerCase();
    const decision =
      rawDecision === "decompose" || rawDecision === "execute" || rawDecision === "done"
        ? rawDecision
        : "execute";
    const subgoalsRaw = Array.isArray(parsed.subgoals)
      ? parsed.subgoals
      : typeof parsed.subgoals === "string"
        ? parsed.subgoals.split(/\r?\n|;/g)
        : [];
    const subgoals = subgoalsRaw
      .map((s) => String(s).trim())
      .filter((s) => s.length > 0)
      .slice(0, 3);
    return {
      decision,
      subgoals,
      reason: String(parsed.reason ?? "").slice(0, 240),
      summary: typeof parsed.summary === "string" ? parsed.summary.slice(0, 500) : undefined
    };
  } catch {
    return null;
  }
}

function parseRlmDecision(text: string): RlmDecision {
  const parsed = tryParseDecisionJson(text);
  if (parsed) {
    return parsed;
  }

  const decideMatch = text.match(/RLM_DECIDE\s*:\s*(DECOMPOSE|EXECUTE|DONE)/i);
  const fallbackDecision = decideMatch ? decideMatch[1].toLowerCase() : "execute";
  const bullets = text
    .split(/\r?\n/g)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- ") || l.startsWith("* "))
    .map((l) => l.slice(2).trim())
    .filter(Boolean)
    .slice(0, 3);
  if (fallbackDecision === "decompose" && bullets.length === 0) {
    return { decision: "execute", subgoals: [], reason: "No valid subgoals returned." };
  }
  if (fallbackDecision === "done") {
    return {
      decision: "done",
      subgoals: [],
      reason: "Model signaled done.",
      summary: extractIterationSummary(text) ?? summarizeModelOutput(text)
    };
  }
  return {
    decision: fallbackDecision === "decompose" ? "decompose" : "execute",
    subgoals: bullets,
    reason: "Heuristic decision parser."
  };
}

interface RecursiveTurnParams {
  step: WorkflowStep;
  runId: string;
  repoPath: string;
  iteration: number;
  rootGoal: string;
  model: string;
  contextPacket: string;
  ui: RunnerUiHooks;
  registry: ReturnType<typeof createProviderRegistry>;
  append: (event: RunEvent) => Promise<void>;
  shouldTerminate: () => boolean;
}

async function runRecursiveLogicTurn(params: RecursiveTurnParams): Promise<string> {
  const { step, runId, repoPath, iteration, rootGoal, model, contextPacket, ui, registry, append, shouldTerminate } =
    params;
  const MAX_DEPTH = 2;
  const MAX_SUBGOALS = 3;
  const MAX_CALLS = 8;
  let callCount = 0;

  const callPhase = async (
    phase: "controller" | "executor" | "synthesizer",
    depth: number,
    goal: string,
    prompt: string,
    streamToUi: boolean
  ): Promise<string> => {
    if (shouldTerminate()) {
      return "Summary: Terminated by user.\n[STEP_DONE]";
    }
    callCount += 1;
    await append(
      toEvent(runId, step.id, "model_called", {
        iteration,
        provider: step.provider,
        model,
        requestedModel: step.model,
        phase,
        depth,
        goal: goal.slice(0, 180),
        rlmRecursive: true
      })
    );
    const candidate = await generateCandidate(
      step,
      runId,
      prompt,
      `${step.id}-i${iteration}-${phase}-d${depth}-c${callCount}`,
      step.provider,
      model,
      ui,
      registry,
      repoPath,
      streamToUi,
      shouldTerminate,
      phase !== "controller"
    );
    await append(
      toEvent(runId, step.id, "candidate_generated", {
        iteration,
        candidateId: candidate.id,
        provider: candidate.provider,
        model: candidate.model,
        phase,
        depth,
        preview: candidate.text.slice(0, 220),
        rlmRecursive: true
      })
    );
    return candidate.text;
  };

  const solve = async (goal: string, depth: number, trail: string[]): Promise<string> => {
    if (shouldTerminate()) {
      return "Summary: Terminated by user.\n[STEP_DONE]";
    }
    if (callCount >= MAX_CALLS) {
      return "Summary: Stopped due to recursion call budget.";
    }

    const controllerPrompt = [
      "RLM_CONTROLLER_MODE",
      "Return strict JSON only: {\"decision\":\"decompose|execute|done\",\"subgoals\":[...],\"reason\":\"...\",\"summary\":\"...\"}.",
      "If decomposing, return at most 3 short subgoals.",
      `Depth: ${depth}/${MAX_DEPTH}`,
      `Goal:\n${goal}`,
      `Trail:\n${trail.join(" -> ").slice(0, 600) || "(root)"}`,
      `Context packet:\n${contextPacket.slice(0, 12_000)}`
    ].join("\n\n");
    const controllerText = await callPhase("controller", depth, goal, controllerPrompt, false);
    const decision = parseRlmDecision(controllerText);
    await append(
      toEvent(runId, step.id, "tool_result", {
        iteration,
        tool: "rlm_controller",
        ok: true,
        depth,
        decision: decision.decision,
        subgoals: decision.subgoals,
        reason: decision.reason
      })
    );

    if (decision.decision === "done") {
      const summary = decision.summary ?? "Goal appears complete.";
      return `Summary: ${summary}\n[STEP_DONE]`;
    }

    if (decision.decision === "decompose" && depth < MAX_DEPTH && decision.subgoals.length > 0) {
      const results: string[] = [];
      for (const sub of decision.subgoals.slice(0, MAX_SUBGOALS)) {
        if (shouldTerminate()) {
          return "Summary: Terminated by user.\n[STEP_DONE]";
        }
        if (callCount >= MAX_CALLS) {
          break;
        }
        const solved = await solve(sub, depth + 1, [...trail, goal]);
        results.push(`Subgoal: ${sub}\nResult:\n${solved.slice(0, 1200)}`);
      }
      const synthPrompt = [
        "RLM_SYNTHESIZER_MODE",
        "Use subgoal results and context to produce the actual step output.",
        "You may emit orchestra_tool requests or a unified diff.",
        "Use the same output format: Summary first line. Use [STEP_DONE] only when the work is actually complete.",
        `Root goal:\n${goal}`,
        `Subgoal results:\n${results.join("\n\n").slice(0, 10_000)}`,
        `Context packet:\n${contextPacket.slice(0, 10_000)}`
      ].join("\n\n");
      return callPhase("synthesizer", depth, goal, synthPrompt, depth === 0);
    }

    const execPrompt = [
      "RLM_EXECUTOR_MODE",
      "Execute this goal directly using available context and tools protocol.",
      "Return practical output for the step. Use the same output format: Summary first line. Use [STEP_DONE] only when the work is actually complete.",
      `Goal:\n${goal}`,
      `Context packet:\n${contextPacket.slice(0, 12_000)}`
    ].join("\n\n");
    return callPhase("executor", depth, goal, execPrompt, depth === 0);
  };

  const result = await solve(rootGoal, 0, []);
  const normalized = normalizeIterationOutput(result);
  if (normalized.length <= 40_000) {
    return normalized;
  }
  const trimmed = normalized.trimEnd();
  const lines = trimmed.split("\n");
  const summaryLine = lines[0] ?? "Summary: (truncated)";
  const signalLine = lines.length > 1 ? lines[lines.length - 1] : "[STEP_DONE]";
  const body = lines.slice(1, -1).join("\n").trim();
  const budget = Math.max(0, 40_000 - summaryLine.length - signalLine.length - 8);
  const clippedBody =
    body.length > budget ? `${body.slice(0, budget).trimEnd()}\n...(truncated)` : body;
  const out = clippedBody ? `${summaryLine}\n\n${clippedBody}\n${signalLine}\n` : `${summaryLine}\n${signalLine}\n`;
  return out;
}

async function executeModelToolCalls(
  runId: string,
  step: WorkflowStep,
  iteration: number,
  requests: ParsedToolRequest[],
  fsTool: FilesystemTool,
  tools: { git: GitTool; tests: TestsTool; shell: ShellTool },
  fsToolCache: Map<string, ExecutedToolResult>,
  fsReadPaths: Set<string>,
  append: (event: RunEvent) => Promise<void>,
  ui: RunnerUiHooks
): Promise<ExecutedActionBatch> {
  const allowed = new Set(step.tools.map((t) => t.trim().toLowerCase()));
  const out: ExecutedToolResult[] = [];
  const limited = requests.slice(0, MAX_MODEL_TOOL_CALLS_PER_ITERATION);
  let interruptedPrompts: string[] = [];
  let interruptedActionSummary: string | undefined;

  if (requests.length > MAX_MODEL_TOOL_CALLS_PER_ITERATION) {
    await append(
      toEvent(runId, step.id, "tool_result", {
        iteration,
        ok: false,
        tool: "orchestra",
        output: `Tool call limit exceeded; only first ${MAX_MODEL_TOOL_CALLS_PER_ITERATION} requests were executed.`
      })
    );
  }

  for (let idx = 0; idx < limited.length; idx += 1) {
    const req = limited[idx];
    const newPrompts = await consumeQueuedPromptsAtCheckpoint(runId, step.id, iteration, "before_tool_execution", ui, append);
    if (newPrompts.length > 0) {
      interruptedPrompts = newPrompts;
      const pendingRequests = limited.slice(idx);
      interruptedActionSummary = summarizeLoopActions(
        pendingRequests.map((pending) => ({
          source: "model",
          tool: normalizeToolName(pending.tool),
          command: pending.command,
          path: pending.path
        }))
      );
      break;
    }
    const normalized = normalizeToolName(req.tool);
    const command = (req.command ?? "").trim();
    const relPath = normalizeRelativePath(req.path ?? ".");
    await append(
      toEvent(runId, step.id, "tool_called", {
        iteration,
        source: "model",
        tool: normalized,
        command: command || undefined,
        path: req.path ?? undefined
      })
    );

    if (normalized === "filesystem.read") {
      if (!allowed.has("filesystem")) {
        const output = "Denied: filesystem tool is not enabled for this step.";
        out.push({ request: req, ok: false, output, cached: false });
        await append(toEvent(runId, step.id, "tool_result", { iteration, tool: normalized, ok: false, output }));
        continue;
      }
      const key = toolCacheKey(normalized, "", relPath);
      const cached = fsToolCache.get(key);
      if (cached) {
        const reused: ExecutedToolResult = { request: req, ok: cached.ok, output: cached.output, cached: true };
        out.push(reused);
        await append(
          toEvent(runId, step.id, "tool_result", {
            iteration,
            tool: normalized,
            ok: cached.ok,
            cached: true,
            output: cached.output
          })
        );
        continue;
      }
      try {
        const content = await fsTool.readFile(relPath);
        const output = content.slice(0, 20_000);
        const result: ExecutedToolResult = { request: req, ok: true, output, cached: false };
        out.push(result);
        fsToolCache.set(key, result);
        fsReadPaths.add(relPath);
        await append(toEvent(runId, step.id, "tool_result", { iteration, tool: normalized, ok: true, output }));
      } catch (error) {
        const output = error instanceof Error ? error.message : String(error);
        const result: ExecutedToolResult = { request: req, ok: false, output, cached: false };
        out.push(result);
        fsToolCache.set(key, result);
        await append(toEvent(runId, step.id, "tool_result", { iteration, tool: normalized, ok: false, output }));
      }
      continue;
    }

    if (normalized === "filesystem.list") {
      if (!allowed.has("filesystem")) {
        const output = "Denied: filesystem tool is not enabled for this step.";
        out.push({ request: req, ok: false, output, cached: false });
        await append(toEvent(runId, step.id, "tool_result", { iteration, tool: normalized, ok: false, output }));
        continue;
      }
      const key = toolCacheKey(normalized, "", relPath);
      const cached = fsToolCache.get(key);
      if (cached) {
        const reused: ExecutedToolResult = { request: req, ok: cached.ok, output: cached.output, cached: true };
        out.push(reused);
        await append(
          toEvent(runId, step.id, "tool_result", {
            iteration,
            tool: normalized,
            ok: cached.ok,
            cached: true,
            output: cached.output
          })
        );
        continue;
      }
      try {
        const entries = await fsTool.listDirectory(relPath);
        const output = entries.slice(0, 300).join("\n");
        const result: ExecutedToolResult = { request: req, ok: true, output, cached: false };
        out.push(result);
        fsToolCache.set(key, result);
        await append(toEvent(runId, step.id, "tool_result", { iteration, tool: normalized, ok: true, output }));
      } catch (error) {
        const output = error instanceof Error ? error.message : String(error);
        const result: ExecutedToolResult = { request: req, ok: false, output, cached: false };
        out.push(result);
        fsToolCache.set(key, result);
        await append(toEvent(runId, step.id, "tool_result", { iteration, tool: normalized, ok: false, output }));
      }
      continue;
    }

    if (normalized === "git" || normalized === "tests" || normalized === "shell") {
      if (!allowed.has(normalized)) {
        const output = `Denied: ${normalized} tool is not enabled for this step.`;
        out.push({ request: req, ok: false, output, cached: false });
        await append(toEvent(runId, step.id, "tool_result", { iteration, tool: normalized, ok: false, output }));
        continue;
      }
      if (!command) {
        const output = "Tool request missing 'command'.";
        out.push({ request: req, ok: false, output, cached: false });
        await append(toEvent(runId, step.id, "tool_result", { iteration, tool: normalized, ok: false, output }));
        continue;
      }
      const result =
        normalized === "git"
          ? await tools.git.run(command)
          : normalized === "tests"
            ? await tools.tests.run(command)
            : await tools.shell.run(command);
      const output = result.output.slice(0, 20_000);
      out.push({ request: req, ok: result.ok, output, cached: false });
      await append(toEvent(runId, step.id, "tool_result", { iteration, tool: normalized, ok: result.ok, output }));
      continue;
    }

    const output = `Unknown tool: ${req.tool}`;
    out.push({ request: req, ok: false, output, cached: false });
    await append(toEvent(runId, step.id, "tool_result", { iteration, tool: normalized, ok: false, output }));
  }

  return { results: out, interruptedPrompts, interruptedActionSummary };
}

function resolveStepIterationBudget(step: WorkflowStep): {
  maxIterations: number;
  autoUnbounded: boolean;
  configuredIterations: number | null;
} {
  const configuredIterations =
    typeof step.iterations === "number" && Number.isFinite(step.iterations) && step.iterations > 0
      ? Math.floor(step.iterations)
      : null;
  if (configuredIterations !== null) {
    return { maxIterations: configuredIterations, autoUnbounded: false, configuredIterations };
  }
  if (process.env.ORCHESTRA_AUTO_UNBOUNDED === "1") {
    return { maxIterations: Number.MAX_SAFE_INTEGER, autoUnbounded: true, configuredIterations };
  }
  return { maxIterations: 12, autoUnbounded: false, configuredIterations };
}

function recursiveLogicEnabled(): boolean {
  return process.env.ORCHESTRA_RECURSIVE_LOGIC === "1";
}

function buildStepSystemPrompt(
  step: WorkflowStep,
  iteration: number,
  maxIterations: number | null,
  priorOutputs: string[]
): string {
  const isPlanStep = step.id.trim().toLowerCase() === "plan";
  const isReviewStep = step.id.trim().toLowerCase() === "review";
  const enabledTools = step.tools.length ? step.tools.join(", ") : "(none)";
  const enabledToolsLine = `Enabled tools for this step: ${enabledTools}.`;
  const historySnippet =
    priorOutputs.length > 0
      ? `Prior iteration outputs (most recent last):\n${priorOutputs
          .slice(-2)
          .map((o, i) => `Iteration-${Math.max(1, priorOutputs.length - 1 + i)}:\n${o.slice(0, 1200)}`)
          .join("\n\n")}`
      : "";

  return [
    BASE_STEP_SYSTEM_PROMPT,
    `Step role: ${step.role}`,
    enabledToolsLine,
    maxIterations === null ? `Iteration: ${iteration} (unbounded)` : `Iteration: ${iteration}/${maxIterations}`,
    isPlanStep
      ? "Planner rule: avoid repeated repository probes. If context is limited or repo is empty, produce a best-effort concise plan and include [STEP_DONE]."
      : "",
    isReviewStep
      ? [
          "Review rule: if verification fails, you may end with [RESTART_WORKFLOW] instead of [STEP_DONE].",
          "Include REPLAN_MESSAGE: <guidance> before that signal.",
          "If a specialized follow-up workflow would help, you may also include one ```orchestra_workflow JSON block describing a temporary WorkflowDefinition for the next pass.",
          'The orchestra_workflow block should be valid JSON with: {"name":"...","description":"...","steps":[{"id":"...","role":"...","provider":"...","model":"...","promptTemplate":"...","tools":["..."],"systemPrompt":"optional","reasoningEffort":"optional","iterations":optional,"gate":{"requireApprovalForDiff":true|false,"requireApprovalForExternalCommands":true|false}}]}',
          "Use the temporary workflow only when the existing workflow shape is a poor fit for the remediation."
        ].join(" ")
      : "",
    step.systemPrompt ? `Step-specific system prompt:\n${step.systemPrompt}` : "",
    historySnippet
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function generateCandidate(
  step: WorkflowStep,
  runId: string,
  prompt: string,
  candidateId: string,
  provider: string,
  model: string,
  ui: RunnerUiHooks,
  registry: ReturnType<typeof createProviderRegistry>,
  repoPath: string,
  streamToUi = true,
  shouldTerminate?: () => boolean,
  normalizeTail = true
): Promise<CandidateResult> {
  const adapter = registry.getAdapter(provider);
  const reasoningEffort = step.reasoningEffort ?? "medium";
  let text = "";
  for await (const token of adapter.stream({
    provider,
    model,
    reasoningEffort,
    prompt,
    stepId: step.id,
    runId,
    cwd: repoPath
  })) {
    if (shouldTerminate?.()) {
      break;
    }
    text += token;
  }
  const finalText = normalizeTail ? normalizeIterationOutput(text) : text;
  if (streamToUi) {
    ui.stream(step.id, finalText);
  }
  return { id: candidateId, provider, model, text: finalText };
}

async function runToolCalls(
  runId: string,
  step: WorkflowStep,
  tools: { git: GitTool; tests: TestsTool; shell: ShellTool },
  append: (event: RunEvent) => Promise<void>
): Promise<void> {
  for (const call of step.toolCalls ?? []) {
    await append(toEvent(runId, step.id, "tool_called", { tool: call.tool, command: call.command }));
    let result: { ok: boolean; output: string };
    if (call.tool === "git") {
      result = await tools.git.run(call.command);
    } else if (call.tool === "tests") {
      result = await tools.tests.run(call.command);
    } else {
      result = await tools.shell.run(call.command);
    }
    await append(
      toEvent(runId, step.id, "tool_result", {
        tool: call.tool,
        ok: result.ok,
        output: result.output.slice(0, 2000)
      })
    );
  }
}

export async function executeRun(request: RunRequest): Promise<RunResult> {
  const runPaths = await createRunPaths(request.runsRoot);
  const logWriter = new EventLogWriter(runPaths.runFile);
  const append = async (event: RunEvent): Promise<void> => {
    await logWriter.append(event);
    if (request.ui.event) {
      try {
        request.ui.event(event);
      } catch {
        // Ignore UI callback failures so runs can proceed.
      }
    }
  };
  const providerRegistry = createProviderRegistry(request.providerConfig);
  let runCancelled = false;
  let cancelLogged = false;
  const isTerminationRequested = (): boolean => Boolean(request.ui.isTerminationRequested?.());
  const noteCancellation = async (stepId: string | null, phase: string): Promise<boolean> => {
    if (!isTerminationRequested()) {
      return false;
    }
    runCancelled = true;
    if (!cancelLogged) {
      cancelLogged = true;
      await append(toEvent(runPaths.runId, stepId, "run_cancelled", { phase }));
      request.ui.log(`Run cancellation requested. Stopping at ${phase}.`);
    }
    return true;
  };

  await writeRunMeta(runPaths.metaFile, {
    runId: runPaths.runId,
    createdAt: runPaths.createdAt,
    repoPath: request.repoPath,
    workflowName: request.workflow.name,
    workflow: request.workflow,
    task: request.task
  });

  request.ui.log(`Run ${runPaths.runId} started.`);
  await append(
    toEvent(runPaths.runId, null, "run_started", {
      repoPath: request.repoPath,
      workflow: request.workflow.name
    })
  );

  const toolCtx: ToolContext = {
    repoRoot: request.repoPath,
    safeMode: request.safeMode,
    requestApproval: request.ui.approval
  };
  const tools = {
    git: new GitTool(toolCtx),
    tests: new TestsTool(toolCtx),
    shell: new ShellTool(toolCtx)
  };
  const filesystem = new FilesystemTool(request.repoPath);
  const baseTask = request.task;
  const maxWorkflowPasses = 3;
  const reviewFeedbackHistory: string[] = [];
  let activeTask = baseTask;
  let activeWorkflow = request.workflow;

  try {
    const runStartedAt = Date.now();
    for (let workflowPass = 1; workflowPass <= maxWorkflowPasses; workflowPass += 1) {
      const completedStepOutputs: CompletedStepOutput[] = [];
      let restartWorkflow = false;
      let restartMessage = "";
      let restartWorkflowOverride: WorkflowDefinition | null = null;

      for (const step of activeWorkflow.steps) {
      if (await noteCancellation(null, "before_step_start")) {
        break;
      }
      const normalizedModel = normalizeModelForProvider(step.provider, step.model);
      const stepModel = normalizedModel.model;
      if (normalizedModel.changed) {
        request.ui.log(`[${step.id}] normalized model "${step.model}" -> "${stepModel}" for provider "${step.provider}".`);
      }
      const { maxIterations, autoUnbounded, configuredIterations } = resolveStepIterationBudget(step);
      const stepLabel = autoUnbounded ? "unbounded (auto)" : `${maxIterations}`;
      request.ui.log(`Step: ${step.id} (up to ${stepLabel} iteration${maxIterations > 1 ? "s" : ""})`);
      await append(
          toEvent(runPaths.runId, step.id, "step_started", {
            role: step.role,
            maxIterations: autoUnbounded ? null : maxIterations,
            iterationMode: autoUnbounded ? "auto_unbounded" : "fixed",
            configuredIterationsIgnored: configuredIterations,
            contextEngine: "rlm",
            workflowPass
          })
        );

      const rlmContext = new RLMContextEngine(runPaths.runId, step, activeTask);
      const fsToolCache = new Map<string, ExecutedToolResult>();
      const fsReadPaths = new Set<string>();
      let summaryCache: RepoSummary | null = null;
      let summaryDirty = true;
      let memoryCache: MemorySearchResult[] | null = null;
      let consecutiveCachedToolOnlyIterations = 0;
      let latestWinnerId: string | null = null;
      let iterationsUsed = 0;
      let stopReason = "max_iterations";
      let filesystemProbeLoopNudge = false;
      let consecutiveFailingFilesystemProbeIterations = 0;
      const failingFilesystemPathCounts = new Map<string, number>();
      let deferredUserPrompts: string[] = [];
      let pendingActionSummary = "";
      let diffRepairContext = "";
      let latestCandidateText = "";
      let latestIterationSummary = "";
      const isPlanStep = step.id.trim().toLowerCase() === "plan";
      const isReviewStep = step.id.trim().toLowerCase() === "review";

      for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
        if (Date.now() - runStartedAt > RUN_WALL_CLOCK_MS) {
          stopReason = "run_timeout";
          request.ui.log(`Run wall-clock budget exceeded (${RUN_WALL_CLOCK_MS}ms). Stopping.`);
          break;
        }
        if (await noteCancellation(step.id, "iteration_start")) {
          stopReason = "terminated_by_user";
          break;
        }
        let summary: RepoSummary;
        let summaryCached = true;
        if (!summaryCache || summaryDirty) {
          summary = await buildRepoSummary(request.repoPath, { maxFiles: 240, maxBytes: 220_000 });
          summaryCache = summary;
          summaryDirty = false;
          summaryCached = false;
        } else {
          summary = summaryCache;
        }
        await append(
          toEvent(runPaths.runId, step.id, "repo_summary_built", {
            iteration,
            cached: summaryCached,
            filesScanned: summary.filesScanned,
            bytesRead: summary.bytesRead,
            truncated: summary.truncated
          })
        );

        const scopes = step.memory?.scopes ?? ["global", "team", "personal"];
        const topK = step.memory?.topK ?? 5;
        let memories: MemorySearchResult[];
        let memoryCached = true;
        if (!memoryCache) {
          memories = await searchMemory(request.memoryRoot, `${activeTask} ${step.role}`, scopes, topK);
          memoryCache = memories;
          memoryCached = false;
        } else {
          memories = memoryCache;
        }
        await append(
          toEvent(runPaths.runId, step.id, "memory_retrieved", {
            iteration,
            cached: memoryCached,
            scopes,
            count: memories.length,
            ids: memories.map((m) => m.id)
          })
        );
        rlmContext.setSnapshot(summary, memories, summaryCached, memoryCached);

        const stepToolSet = new Set(step.tools.map((t) => t.trim().toLowerCase()));
        if (stepToolSet.has("filesystem") && rlmContext.getRecentToolResults().length === 0) {
          try {
            await append(
              toEvent(runPaths.runId, step.id, "tool_called", {
                iteration,
                source: "orchestra_bootstrap",
                tool: "filesystem.list",
                path: "."
              })
            );
            const rootEntries = await filesystem.listDirectory(".");
            const listing = rootEntries.slice(0, 120).join("\n");
            await append(
              toEvent(runPaths.runId, step.id, "tool_result", {
                iteration,
                source: "orchestra_bootstrap",
                tool: "filesystem.list",
                ok: true,
                output: listing
              })
            );
            rlmContext.recordToolResult(iteration, "filesystem.list|.|", false, true, listing);
            rlmContext.rememberReadPath(".");
          } catch (error) {
            const output = error instanceof Error ? error.message : String(error);
            await append(
              toEvent(runPaths.runId, step.id, "tool_result", {
                iteration,
                source: "orchestra_bootstrap",
                tool: "filesystem.list",
                ok: false,
                output
              })
            );
            rlmContext.recordToolResult(iteration, "filesystem.list|.|", false, false, output);
            rlmContext.rememberFailedPath(".", output);
          }
        }

        const promptBody = renderTemplate(step.promptTemplate, {
          task: activeTask,
          repoTree: summary.treeLines.slice(0, 120).join("\n"),
          keyFiles: summary.keyFiles.map((f) => `FILE: ${f.path}\n${f.snippet}`).join("\n\n"),
          memory: memories.map((m) => `[${m.scope}] ${m.content}`).join("\n"),
          toolResults: rlmContext.getRecentToolResults()
        });

        const rlmPacket = rlmContext.renderPromptContext(45_000);
        const recentToolResults = rlmContext.getRecentToolResults();
        const priorWorkflowOutputs = renderPriorWorkflowOutputs(completedStepOutputs, step.id);
        const repoAppearsEmpty = summary.filesScanned === 0 && summary.treeLines.length === 0 && summary.keyFiles.length === 0;
        const repoAppearsUninitialized = repoAppearsEmpty || !repoHasImplementationFiles(summary);
        const pendingUserPrompts = [...deferredUserPrompts, ...(request.ui.consumePendingUserPrompts?.() ?? [])];
        deferredUserPrompts = [];
        if (pendingUserPrompts.length > 0) {
          request.ui.log(`[${step.id} i${iteration}] Injecting ${pendingUserPrompts.length} queued user prompt(s).`);
          await append(
            toEvent(runPaths.runId, step.id, "user_prompt_injected", {
              iteration,
              count: pendingUserPrompts.length,
              prompts: pendingUserPrompts.map((p) => p.slice(0, 2000))
            })
          );
        }
        const promptSections: string[] = [
          buildStepSystemPrompt(step, iteration, null, rlmContext.getPriorOutputs()),
          pendingActionSummary ? `Interrupted pending actions from the prior loop:\n${pendingActionSummary}` : "",
          diffRepairContext ? `Patch repair context:\n${diffRepairContext}` : "",
          `Workflow pass: ${workflowPass}/${maxWorkflowPasses}`,
          priorWorkflowOutputs ? `Outputs from earlier workflow steps in this pass:\n${priorWorkflowOutputs}` : "",
          filesystemProbeLoopNudge
            ? "Filesystem probe guard: previous filesystem probes repeatedly failed (missing path/directory mismatch). Do NOT retry the same paths; use failedFilesystemPaths from RLM context and move forward."
            : "",
          "Task + context:",
          promptBody,
          recentToolResults
            ? `Recent tool results (reuse this context; avoid duplicate reads/lists unless files changed):\n${recentToolResults}`
            : "",
          repoAppearsUninitialized
            ? "Repo state: repository appears empty/uninitialized (no runnable code files). Do NOT loop on filesystem probes; proceed with best-effort output and [STEP_DONE]."
            : "",
          rlmPacket,
          pendingUserPrompts.length > 0
            ? `Live user instructions for this iteration:\n${pendingUserPrompts
                .map((msg, idx) => `${idx + 1}. ${msg}`)
                .join("\n")}`
            : "",
          "Use the RLM context packet above as source of truth. Avoid requesting filesystem data that already appears there unless files changed."
        ];
        const prompt = promptSections.join("\n\n");
        pendingActionSummary = "";
        diffRepairContext = "";

        let candidate: CandidateResult;
        const modelCallStartedAt = Date.now();
        request.ui.log(`[${step.id} i${iteration}] model call started (${step.provider}/${stepModel}).`);
        const isRecursiveLogicStep = step.id.toLowerCase() === "logic" && recursiveLogicEnabled();
        if (isRecursiveLogicStep) {
          const text = await runRecursiveLogicTurn({
            step,
            runId: runPaths.runId,
            repoPath: request.repoPath,
            iteration,
            rootGoal: promptBody,
            model: stepModel,
            contextPacket: rlmPacket,
            ui: request.ui,
            registry: providerRegistry,
            append,
            shouldTerminate: isTerminationRequested
          });
          candidate = {
            id: `${step.id}-i${iteration}-recursive-final`,
            provider: step.provider,
            model: stepModel,
            text
          };
        } else {
          await append(
            toEvent(runPaths.runId, step.id, "model_called", {
              iteration,
              provider: step.provider,
              model: stepModel,
              requestedModel: step.model,
              contextEngine: "rlm",
              promptChars: prompt.length
            })
          );
          candidate = await generateCandidate(
            step,
            runPaths.runId,
            prompt,
            `${step.id}-i${iteration}-c1`,
            step.provider,
            stepModel,
            request.ui,
            providerRegistry,
            request.repoPath,
            true,
            isTerminationRequested
          );
        }
        const modelCallElapsed = ((Date.now() - modelCallStartedAt) / 1000).toFixed(1);
        request.ui.log(`[${step.id} i${iteration}] model call finished in ${modelCallElapsed}s.`);
        if (await noteCancellation(step.id, "post_model_call")) {
          stopReason = "terminated_by_user";
          break;
        }
        const parsedToolCalls = parseModelToolRequests(candidate.text);
        const providerTrace = consumeProviderTrace(runPaths.runId, step.id);
        const providerToolCalls = providerTrace.toolCalls.slice(0, 12);
        const loopActions = buildLoopActions(parsedToolCalls.requests, providerToolCalls);
        for (const providerTool of providerToolCalls) {
          await append(
            toEvent(runPaths.runId, step.id, "tool_called", {
              iteration,
              source: providerTool.source,
              tool: providerTool.tool,
              command: providerTool.command
            })
          );
          await append(
            toEvent(runPaths.runId, step.id, "tool_result", {
              iteration,
              source: providerTool.source,
              tool: providerTool.tool,
              ok: providerTool.ok,
              exitCode: providerTool.exitCode ?? null,
              status: providerTool.status ?? "completed",
              output: providerTool.output.slice(0, 20_000)
            })
          );
          rlmContext.recordToolResult(
            iteration,
            `provider:${providerTool.tool}:${providerTool.command.slice(0, 140)}`,
            false,
            providerTool.ok,
            providerTool.output
          );
        }
        if (providerTrace.rawJsonEvents.length > 0) {
          await append(
            toEvent(runPaths.runId, step.id, "tool_result", {
              iteration,
              source: "provider_json",
              tool: "provider.raw_json",
              ok: true,
              output: providerTrace.rawJsonEvents.slice(0, 16).join("\n").slice(0, 20_000)
            })
          );
        }
        const repeatedFilesystemRequestSignatures = parsedToolCalls.requests
          .map((req) => ({ req, signature: requestSignature(req) }))
          .filter((entry) => isFilesystemRequest(entry.req) && rlmContext.hasSeenToolSignature(entry.signature))
          .map((entry) => entry.signature);
        await append(
          toEvent(runPaths.runId, step.id, "candidate_generated", {
            iteration,
            candidateId: candidate.id,
            provider: candidate.provider,
            model: candidate.model,
            preview: candidate.text.slice(0, 240),
            summary: extractIterationSummary(candidate.text) ?? summarizeModelOutput(candidate.text),
            outputChars: candidate.text.length,
            modelOutput: candidate.text.slice(0, 20_000),
            toolRequests: parsedToolCalls.requests,
            actionSummary: summarizeLoopActions(loopActions, 10),
            providerToolCalls: providerToolCalls.map((call) => ({
              source: call.source,
              tool: call.tool,
              command: call.command,
              ok: call.ok,
              exitCode: call.exitCode ?? null,
              status: call.status ?? "completed"
            })),
            providerRawJsonEvents: providerTrace.rawJsonEvents.length
          })
        );
        const iterationSummary = extractIterationSummary(candidate.text) ?? summarizeModelOutput(candidate.text);
        latestCandidateText = candidate.text;
        latestIterationSummary = iterationSummary;
        rlmContext.recordIteration(iteration, iterationSummary, candidate.text);
        request.ui.log(`[${step.id} i${iteration}] ${iterationSummary}`);
        latestWinnerId = candidate.id;
        iterationsUsed = iteration;
        await append(
          toEvent(runPaths.runId, step.id, "vote_completed", {
            iteration,
            strategy: "single_candidate",
            winner: candidate.id,
            reason: "Single-agent mode: automatic multi-candidate voting is disabled.",
            candidates: [{ id: candidate.id, provider: candidate.provider, model: candidate.model }]
          })
        );

        if (parsedToolCalls.parseErrors.length > 0) {
          await append(
            toEvent(runPaths.runId, step.id, "tool_result", {
              iteration,
              tool: "orchestra_tool_parse",
              ok: false,
              output: parsedToolCalls.parseErrors.join(" | ").slice(0, 1000)
            })
          );
        }
        const executedActionBatch = await executeModelToolCalls(
          runPaths.runId,
          step,
          iteration,
          parsedToolCalls.requests,
          filesystem,
          tools,
          fsToolCache,
          fsReadPaths,
          append,
          request.ui
        );
        if (executedActionBatch.interruptedPrompts.length > 0) {
          deferredUserPrompts.push(...executedActionBatch.interruptedPrompts);
          pendingActionSummary =
            executedActionBatch.interruptedActionSummary ||
            summarizeLoopActions(loopActions.filter((action) => action.source === "model"));
          stopReason = "mid_turn_user_redirect";
          request.ui.log(
            `[${step.id} i${iteration}] restarting loop with fresh user instructions before executing more actions.`
          );
          continue;
        }
        const executedToolCalls = executedActionBatch.results;
        const hadModelToolCalls = executedToolCalls.length > 0;
        const hadProviderToolCalls = providerToolCalls.length > 0;
        const hadAnyToolCalls = hadModelToolCalls || hadProviderToolCalls;
        const hadFreshModelToolCalls = executedToolCalls.some((r) => !r.cached);
        const hadOnlyCachedModelToolCalls = hadModelToolCalls && !hadFreshModelToolCalls && !hadProviderToolCalls;
        const filesystemResults = executedToolCalls.filter((res) => isFilesystemRequest(res.request));
        const freshFilesystemResults = filesystemResults.filter((res) => !res.cached);
        const freshFilesystemFailures = freshFilesystemResults.filter((res) => !res.ok);
        const freshFilesystemSuccesses = freshFilesystemResults.filter((res) => res.ok);
        const modelOnlyCalledFilesystemTools =
          hadModelToolCalls && executedToolCalls.every((res) => isFilesystemRequest(res.request));
        if (hadOnlyCachedModelToolCalls) {
          consecutiveCachedToolOnlyIterations += 1;
        } else {
          consecutiveCachedToolOnlyIterations = 0;
        }
        for (const res of executedToolCalls) {
          const signature = requestSignature(res.request);
          rlmContext.rememberToolSignature(signature);
          rlmContext.recordToolResult(iteration, signature, res.cached, res.ok, res.output);
          if (!res.request.path) {
            continue;
          }
          const normalizedPath = normalizeRelativePath(res.request.path);
          if (res.ok) {
            rlmContext.rememberReadPath(normalizedPath);
          } else if (isLikelyPathProbeError(res.output)) {
            rlmContext.rememberFailedPath(normalizedPath, res.output);
          }
        }
        for (const res of freshFilesystemFailures) {
          const normalizedPath = normalizeRelativePath(res.request.path ?? ".");
          const nextCount = (failingFilesystemPathCounts.get(normalizedPath) ?? 0) + 1;
          failingFilesystemPathCounts.set(normalizedPath, nextCount);
        }
        if (freshFilesystemSuccesses.length > 0 || hadProviderToolCalls) {
          consecutiveFailingFilesystemProbeIterations = 0;
          filesystemProbeLoopNudge = false;
        } else if (freshFilesystemFailures.length > 0 && modelOnlyCalledFilesystemTools) {
          consecutiveFailingFilesystemProbeIterations += 1;
          filesystemProbeLoopNudge = true;
        } else if (!hadModelToolCalls || !modelOnlyCalledFilesystemTools) {
          consecutiveFailingFilesystemProbeIterations = 0;
        }
        const diffText = extractFirstDiffFence(candidate.text);
        let hadDiff = false;
        let diffRejected = false;
        let diffApplyFailed = false;
        if (diffText) {
          hadDiff = true;
          const diffSummary = summarizeDiff(diffText);
          const artifactPath = await saveDiffArtifact(runPaths.artifactsDir, `${step.id}-i${iteration}`, diffText);
          await append(
            toEvent(runPaths.runId, step.id, "diff_detected", {
              iteration,
              artifactPath,
              files: diffSummary.files,
              additions: diffSummary.additions,
              deletions: diffSummary.deletions
            })
          );

          const requireApproval = step.gate?.requireApprovalForDiff ?? true;
          let approved = true;
          if (requireApproval) {
            await append(
              toEvent(runPaths.runId, step.id, "approval_requested", {
                iteration,
                kind: "diff_apply",
                files: diffSummary.files
              })
            );
            approved = await request.ui.approval({
              title: "Approve diff application",
              message: `Apply proposed patch for step "${step.id}" (iteration ${iteration})?`,
              detail: `Files: ${diffSummary.files.join(", ") || "(unknown)"}\n+${diffSummary.additions} -${diffSummary.deletions}`
            });
            await append(
              toEvent(runPaths.runId, step.id, "approval_result", {
                iteration,
                kind: "diff_apply",
                approved
              })
            );
          }

          if (approved) {
            const promptsBeforeDiffApply = await consumeQueuedPromptsAtCheckpoint(
              runPaths.runId,
              step.id,
              iteration,
              "before_diff_apply",
              request.ui,
              append
            );
            if (promptsBeforeDiffApply.length > 0) {
              deferredUserPrompts.push(...promptsBeforeDiffApply);
              pendingActionSummary = [
                "A diff was ready but not yet applied.",
                `Files: ${diffSummary.files.join(", ") || "(unknown)"}`,
                `Additions: ${diffSummary.additions}`,
                `Deletions: ${diffSummary.deletions}`
              ].join("\n");
              stopReason = "mid_turn_user_redirect";
              request.ui.log(`[${step.id} i${iteration}] deferring diff apply to honor new user instructions.`);
              continue;
            }
            try {
              const changed = await applyUnifiedDiff(request.repoPath, diffText);
              await append(toEvent(runPaths.runId, step.id, "diff_applied", { iteration, changed }));
              rlmContext.noteDiffApplied(changed);
              rlmContext.clearFileCachesAfterWrite();
              summaryDirty = true;
              fsToolCache.clear();
              fsReadPaths.clear();
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              diffApplyFailed = true;
              const output = `Diff apply failed: ${message}`;
              diffRepairContext = buildDiffRepairContext(step.id, iteration, diffText, message);
              await append(
                toEvent(runPaths.runId, step.id, "tool_result", {
                  iteration,
                  tool: "diff.apply",
                  ok: false,
                  output
                })
              );
              rlmContext.recordToolResult(iteration, "diff.apply", false, false, output);
              request.ui.log(`[${step.id} i${iteration}] ${output}`);
            }
          } else {
            diffRejected = true;
          }
        }

        const doneSignal = /\[STEP_DONE\]|<step_done>|STEP_DONE\b/i.test(candidate.text);
        const continueSignal = /\[CONTINUE\]|<continue>|CONTINUE_ITERATION\b/i.test(candidate.text);
        const restartWorkflowSignal =
          isReviewStep && /\[RESTART_WORKFLOW\]|<restart_workflow>|RESTART_WORKFLOW\b/i.test(candidate.text);
        const reviewRestartMessage = isReviewStep ? extractWorkflowRestartMessage(candidate.text) : null;
        const reviewTemporaryWorkflow = isReviewStep ? extractTemporaryWorkflow(candidate.text) : null;
        const needsFollowUp = hadAnyToolCalls || diffApplyFailed;

        if (diffRejected) {
          stopReason = "diff_rejected";
          break;
        }
        if (diffApplyFailed) {
          stopReason = "diff_apply_failed";
          // Mirror Codex behavior: when a tool/action output requires another model pass, continue.
          continue;
        }

        if (hadOnlyCachedModelToolCalls && consecutiveCachedToolOnlyIterations >= 1 && !hadDiff) {
          stopReason = "repeated_cached_tool_calls";
          request.ui.log(
            `[${step.id} i${iteration}] stopping repeated cached tool-call loop; model must use prior context to progress.`
          );
          break;
        }
        if (
          !hadDiff &&
          !hadProviderToolCalls &&
          modelOnlyCalledFilesystemTools &&
          freshFilesystemFailures.length > 0 &&
          freshFilesystemSuccesses.length === 0
        ) {
          const repeatedFailedPathCount = [...failingFilesystemPathCounts.values()].filter((count) => count >= 2).length;
          const repeatedFilesystemRequestCount = new Set(repeatedFilesystemRequestSignatures).size;
          const failingProbeThreshold = repoAppearsUninitialized ? 2 : 4;
          if (
            consecutiveFailingFilesystemProbeIterations >= failingProbeThreshold ||
            repeatedFailedPathCount >= 3 ||
            (repeatedFilesystemRequestCount >= 2 && consecutiveFailingFilesystemProbeIterations >= 2)
          ) {
            stopReason = repoAppearsUninitialized ? "repo_empty_repeated_fs_probes" : "repeated_failing_fs_probes";
            const detail =
              repoAppearsUninitialized
                ? "Repository appears empty or not initialized for this task. Stopping repeated filesystem probing and finishing the step."
                : "Stopping repeated failing filesystem probes. Reuse prior context instead of retrying missing paths.";
            await append(
              toEvent(runPaths.runId, step.id, "tool_result", {
                iteration,
                tool: "orchestra",
                ok: false,
                output: detail
              })
            );
            request.ui.log(`[${step.id} i${iteration}] ${detail}`);
            break;
          }
        }

        if (doneSignal && !needsFollowUp) {
          if (isPlanStep) {
            await append(
              toEvent(runPaths.runId, step.id, "approval_requested", {
                iteration,
                kind: "plan_step",
                summary: iterationSummary.slice(0, 500)
              })
            );
            const defaultReview = async (): Promise<{ approved: boolean; feedback?: string }> => {
              const approved = await request.ui.approval({
                title: "Approve plan",
                message: `Approve plan from step "${step.id}" (iteration ${iteration})?`,
                detail: iterationSummary.slice(0, 500)
              });
              return { approved };
            };
            const planReviewResult = request.ui.planReview
              ? await request.ui.planReview({
                  stepId: step.id,
                  iteration,
                  summary: iterationSummary,
                  plan: candidate.text
                })
              : await defaultReview();
            const reviewFeedback = planReviewResult.feedback?.trim() ?? "";
            await append(
              toEvent(runPaths.runId, step.id, "approval_result", {
                iteration,
                kind: "plan_step",
                approved: planReviewResult.approved,
                feedback: reviewFeedback ? reviewFeedback.slice(0, 2000) : undefined
              })
            );
            if (planReviewResult.approved) {
              stopReason = "plan_approved_by_user";
              break;
            }
            const feedbackForPrompt =
              reviewFeedback ||
              "User did not approve the plan. Revise it with clearer execution details and better alignment to the task.";
            deferredUserPrompts.push(`User feedback on the plan:\n${feedbackForPrompt}`);
            pendingActionSummary =
              "The previous plan was rejected by the user. Produce a revised plan that addresses the feedback, then end with [STEP_DONE] for approval.";
            request.ui.log(`[${step.id} i${iteration}] plan rejected by user; revising plan.`);
            continue;
          }
          stopReason = "model_signaled_done";
          break;
        }

        if (restartWorkflowSignal && !diffApplyFailed) {
          stopReason = "workflow_restart_requested";
          restartWorkflow = true;
          restartMessage = reviewRestartMessage ?? iterationSummary;
          restartWorkflowOverride = reviewTemporaryWorkflow;
          request.ui.log(`[${step.id} i${iteration}] review requested a workflow restart.`);
          break;
        }

        if (continueSignal && !needsFollowUp) {
          request.ui.log(
            `[${step.id} i${iteration}] ignoring [CONTINUE] because no tool outputs or actionable follow-up were produced.`
          );
        }

        if (!needsFollowUp) {
          stopReason = hadDiff ? "diff_applied_no_follow_up" : "model_no_follow_up_needed";
          break;
        }

        if (iteration >= 256) {
          stopReason = "safety_iteration_cap";
          request.ui.log(
            `[${step.id} i${iteration}] reached safety iteration cap (256) while follow-ups were still requested.`
          );
          break;
        }

        stopReason = hadAnyToolCalls ? "tool_calls_executed" : "model_requested_follow_up";
        continue;
      }

      if (runCancelled) {
        break;
      }
      if (!restartWorkflow) {
        await runToolCalls(runPaths.runId, step, tools, append);
      }
      if (runCancelled) {
        break;
      }
      if (latestCandidateText) {
        completedStepOutputs.push({
          stepId: step.id,
          role: step.role,
          summary: latestIterationSummary || summarizeModelOutput(latestCandidateText),
          output: latestCandidateText
        });
      }

      await append(
        toEvent(runPaths.runId, step.id, "step_finished", {
          winner: latestWinnerId,
          iterationsUsed,
          stopReason,
          workflowPass,
          workflowRestartRequested: restartWorkflow,
          restartMessage: restartWorkflow ? restartMessage : undefined
        })
      );
      if (restartWorkflow) {
        break;
      }
    }

    if (runCancelled) {
      await append(toEvent(runPaths.runId, null, "run_finished", { ok: false, cancelled: true }));
      request.ui.log(`Run ${runPaths.runId} cancelled.`);
      return { runId: runPaths.runId, ok: false };
    }
    if (restartWorkflow) {
      reviewFeedbackHistory.push(restartMessage || "Review requested another workflow pass.");
      activeTask = buildWorkflowTask(baseTask, reviewFeedbackHistory);
      activeWorkflow = createRestartWorkflow(
        request.workflow,
        reviewFeedbackHistory.at(-1) ?? restartMessage,
        workflowPass,
        restartWorkflowOverride
      );
      request.ui.log(
        `Restarting workflow from plan with review feedback (${workflowPass}/${maxWorkflowPasses} completed): ${reviewFeedbackHistory.at(-1)}`
      );
      if (restartWorkflowOverride) {
        request.ui.log(
          `Using review-generated temporary workflow for follow-up pass ${workflowPass + 1}: ${restartWorkflowOverride.name}`
        );
      }
      if (workflowPass >= maxWorkflowPasses) {
        await append(
          toEvent(runPaths.runId, null, "error", {
            message: "Review requested another workflow restart, but the workflow pass limit was reached.",
            workflowPass,
            maxWorkflowPasses,
            restartMessage: reviewFeedbackHistory.at(-1)
          })
        );
        await append(toEvent(runPaths.runId, null, "run_finished", { ok: false, reviewRestartLimitReached: true }));
        request.ui.log(`Run ${runPaths.runId} stopped after reaching the workflow restart limit.`);
        return { runId: runPaths.runId, ok: false };
      }
      continue;
    }

      await append(toEvent(runPaths.runId, null, "run_finished", { ok: true, workflowPass }));
      request.ui.log(`Run ${runPaths.runId} finished.`);
      return { runId: runPaths.runId, ok: true };
    }

    await append(toEvent(runPaths.runId, null, "run_finished", { ok: false, reason: "workflow_ended_without_terminal_state" }));
    request.ui.log(`Run ${runPaths.runId} ended without a terminal workflow outcome.`);
    return { runId: runPaths.runId, ok: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await append(toEvent(runPaths.runId, null, "error", { message }));
    await append(toEvent(runPaths.runId, null, "run_finished", { ok: false }));
    request.ui.log(`Run failed: ${message}`);
    return { runId: runPaths.runId, ok: false };
  }
}

export function buildDiffPreviewPath(repoPath: string, relativePath: string): string {
  return path.join(repoPath, relativePath);
}
