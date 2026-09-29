export type MemoryScope = "global" | "team" | "personal";

export interface OrchestraConfig {
  safeMode: boolean;
  recentRepos: string[];
  providers: {
    openaiCompatible?: {
      baseUrl?: string;
      apiKey?: string;
      defaultModel?: string;
      headers?: Record<string, string>;
    };
    openrouter?: {
      baseUrl?: string;
      apiKey?: string;
      referer?: string;
      title?: string;
      defaultModel?: string;
    };
    nim?: {
      baseUrl?: string;
      apiKey?: string;
      defaultModel?: string;
    };
    codexApi?: {
      baseUrl?: string;
      apiKey?: string;
      defaultModel?: string;
      headers?: Record<string, string>;
      enabled?: boolean;
    };
    codexSubscription?: {
      command?: string;
      enabled?: boolean;
      transport?: "cli" | "api";
      apiBaseUrl?: string;
    };
    claudeSubscription?: {
      command?: string;
      enabled?: boolean;
    };
    openai?: { apiKey?: string };
    anthropic?: { apiKey?: string };
    google?: { apiKey?: string };
    local?: Record<string, never>;
  };
}

export interface WorkflowMemoryConfig {
  scopes?: MemoryScope[];
  topK?: number;
}

export interface WorkflowVoteConfig {
  strategy: "best_of_n_same_model" | "cross_model_vote" | "judge_model";
  n?: number;
  models?: Array<{ provider: string; model: string }>;
  judge?: { provider: string; model: string };
}

export interface WorkflowGateConfig {
  requireApprovalForDiff?: boolean;
  requireApprovalForExternalCommands?: boolean;
}

export interface WorkflowToolCall {
  tool: "git" | "tests" | "shell";
  command: string;
}

export type ReasoningEffort = "low" | "medium" | "high";

export interface WorkflowStep {
  id: string;
  role: string;
  provider: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
  promptTemplate: string;
  systemPrompt?: string;
  iterations?: number;
  tools: string[];
  voting?: WorkflowVoteConfig;
  gate?: WorkflowGateConfig;
  memory?: WorkflowMemoryConfig;
  toolCalls?: WorkflowToolCall[];
}

export interface WorkflowDefinition {
  schemaVersion?: number;
  name: string;
  description?: string;
  steps: WorkflowStep[];
}

export interface MemoryItem {
  id: string;
  scope: MemoryScope;
  tags?: string[];
  createdAt: string;
  content: string;
}

export interface MemorySearchResult extends MemoryItem {
  score: number;
  sourcePath: string;
}

export interface RunRecord {
  runId: string;
  createdAt: string;
  repoPath: string;
  workflowName: string;
}

export interface RunEvent {
  ts: string;
  runId: string;
  stepId: string | null;
  type:
    | "run_started"
    | "step_started"
    | "repo_summary_built"
    | "memory_retrieved"
    | "model_called"
    | "candidate_generated"
    | "vote_completed"
    | "diff_detected"
    | "approval_requested"
    | "approval_result"
    | "diff_applied"
    | "tool_called"
    | "tool_result"
    | "user_prompt_injected"
    | "run_cancelled"
    | "step_finished"
    | "run_finished"
    | "error";
  data: Record<string, unknown>;
}

export interface ModelRequest {
  provider: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
  prompt: string;
  stepId: string;
  runId: string;
  cwd?: string;
}

export interface ModelResponse {
  text: string;
  raw?: Record<string, unknown>;
}

export interface CandidateResult {
  id: string;
  provider: string;
  model: string;
  text: string;
  score?: number;
  reason?: string;
}

export interface VoteOutcome {
  strategy: WorkflowVoteConfig["strategy"];
  winner: CandidateResult;
  candidates: CandidateResult[];
  reason: string;
}

export interface RepoSummary {
  treeLines: string[];
  keyFiles: Array<{ path: string; snippet: string }>;
  truncated: boolean;
  filesScanned: number;
  bytesRead: number;
}

export interface ApprovalRequest {
  title: string;
  message: string;
  detail?: string;
}

export interface PlanReviewRequest {
  stepId: string;
  iteration: number;
  summary: string;
  plan: string;
}

export interface PlanReviewResponse {
  approved: boolean;
  feedback?: string;
}

export interface RunnerUiHooks {
  log: (line: string) => void;
  stream: (stepId: string, token: string) => void;
  approval: (request: ApprovalRequest) => Promise<boolean>;
  planReview?: (request: PlanReviewRequest) => Promise<PlanReviewResponse>;
  isTerminationRequested?: () => boolean;
  consumePendingUserPrompts?: () => string[];
  event?: (event: RunEvent) => void;
}

export interface RunResult {
  runId: string;
  ok: boolean;
}
