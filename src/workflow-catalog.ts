import fs from "node:fs/promises";
import path from "node:path";
import { stringify as yamlStringify } from "yaml";
import { normalizeWorkflowModels } from "./model-ids";
import { OrchestraConfig, WorkflowDefinition, WorkflowGateConfig, WorkflowMemoryConfig, WorkflowStep } from "./types";

export type BuiltinWorkflowAudience = "openai_subscriber" | "claude_subscriber" | "api_router_user";

export type BuiltinWorkflowCategory =
  | "base_software_development"
  | "game_development"
  | "web_development"
  | "debugging_workflow"
  | "tester_qa"
  | "security"
  | "data_science"
  | "documentation";

interface StepSeed {
  id: string;
  role: string;
  title: string;
  goal: string;
  provider: string;
  model: string;
  reasoningEffort?: "low" | "medium" | "high";
  tools: string[];
  gate?: WorkflowGateConfig;
  memory?: WorkflowMemoryConfig;
  style: "plan" | "analysis" | "implementation" | "debug" | "testing" | "review" | "docs";
}

interface TemplateSeed {
  category: BuiltinWorkflowCategory;
  audience: BuiltinWorkflowAudience;
  name: string;
  description: string;
  steps: StepSeed[];
}

export interface BuiltinWorkflowTemplate {
  id: string;
  fileName: string;
  category: BuiltinWorkflowCategory;
  audience: BuiltinWorkflowAudience;
  name: string;
  description: string;
  workflow: WorkflowDefinition;
}

const DEFAULT_REASONING: "medium" = "medium";
const PLAN_MEMORY: WorkflowMemoryConfig = { scopes: ["team", "personal"], topK: 4 };

export const BUILTIN_WORKFLOW_AUDIENCE_LABELS: Record<BuiltinWorkflowAudience, string> = {
  openai_subscriber: "OpenAI subscriber",
  claude_subscriber: "Claude subscriber",
  api_router_user: "API/router user"
};

export const BUILTIN_WORKFLOW_CATEGORY_LABELS: Record<BuiltinWorkflowCategory, string> = {
  base_software_development: "Base software development",
  game_development: "Game development",
  web_development: "Web development",
  debugging_workflow: "Debugging workflow",
  tester_qa: "Tester / QA",
  security: "Security",
  data_science: "Data science",
  documentation: "Documentation"
};

const CATEGORY_CLASSIFIER_HINTS: Record<BuiltinWorkflowCategory, Array<string | RegExp>> = {
  base_software_development: ["backend", "api", "service", "library", "cli", "database", "refactor", "feature", "integration", "server"],
  game_development: ["game", "gameplay", "hud", "enemy", "npc", "combat", "level", "physics", "inventory", "unity", "unreal"],
  web_development: ["web", "website", "frontend", "landing page", "browser", "react", "next.js", "html", "css", "dashboard", /ux|user experience|ui/i],
  debugging_workflow: ["debug", "bug", "broken", "fix crash", "exception", "stack trace", "failing", "regression", "reproduce", "root cause", "not working"],
  tester_qa: ["test", "qa", "e2e", "unit test", "integration test", "playwright", "cypress", "coverage", "verify", "smoke test"],
  security: ["security", "vulnerability", "threat model", "xss", "csrf", "sql injection", "secret", "hardening", "permission", "cve"],
  data_science: ["dataset", "analysis", "notebook", "sql", "pandas", "model", "train", "forecast", "feature engineering", "experiment"],
  documentation: ["documentation", "docs", "readme", "guide", "manual", "tutorial", "reference", "api docs", "runbook"]
};

function makeGate(diff = false, external = false): WorkflowGateConfig | undefined {
  if (!diff && !external) {
    return undefined;
  }
  return {
    ...(diff ? { requireApprovalForDiff: true } : {}),
    ...(external ? { requireApprovalForExternalCommands: true } : {})
  };
}

function phase(
  id: string,
  title: string,
  role: string,
  style: StepSeed["style"],
  provider: string,
  model: string,
  goal: string,
  tools: string[],
  extra?: { gate?: WorkflowGateConfig; memory?: WorkflowMemoryConfig; reasoningEffort?: "low" | "medium" | "high" }
): StepSeed {
  return {
    id,
    title,
    role,
    style,
    provider,
    model,
    goal,
    tools,
    ...(extra?.gate ? { gate: extra.gate } : {}),
    ...(extra?.memory ? { memory: extra.memory } : {}),
    ...(extra?.reasoningEffort ? { reasoningEffort: extra.reasoningEffort } : {})
  };
}

function planPrompt(categoryLabel: string, title: string, goal: string): string {
  return [
    `Produce the ${title.toLowerCase()} output for this ${categoryLabel.toLowerCase()} workflow.`,
    `Task:\n{{task}}`,
    goal,
    "Use repository context and earlier step outputs when available.",
    "Keep the handoff concise, concrete, and directly useful for the next step."
  ].join("\n\n");
}

function implementationPrompt(categoryLabel: string, title: string, goal: string): string {
  return [
    `${title} for this ${categoryLabel.toLowerCase()} task:`,
    "{{task}}",
    goal,
    "Use earlier workflow outputs as implementation guidance.",
    "Make real repository changes when code changes are warranted and return them as a unified diff."
  ].join("\n\n");
}

function reviewPrompt(categoryLabel: string, title: string, goal: string): string {
  return [
    `${title} for this ${categoryLabel.toLowerCase()} task:`,
    "{{task}}",
    goal,
    "Use repository context, earlier workflow outputs, and tests when relevant.",
    "If the work is sufficient, summarize the outcome and end with [STEP_DONE].",
    "If more work is needed, hand off concrete next actions without making unrelated changes."
  ].join("\n\n");
}

function createSystemPrompt(step: StepSeed, categoryLabel: string): string {
  if (step.style === "implementation") {
    return [
      `You are the ${step.title.toLowerCase()} step for a ${categoryLabel.toLowerCase()} workflow.`,
      step.goal,
      "Prefer making concrete repository changes over writing generic advice.",
      "Request more context only when needed, and output code changes as unified diff blocks.",
      "End with [STEP_DONE] when this step's implementation pass is complete."
    ].join("\n");
  }
  if (step.style === "debug") {
    return [
      `You are the ${step.title.toLowerCase()} step for a ${categoryLabel.toLowerCase()} workflow.`,
      step.goal,
      "Investigate the actual codebase and prior step outputs.",
      "When a fix is warranted, make concrete code or configuration changes instead of only listing hypotheses.",
      "End with [STEP_DONE] when the debugging pass is complete."
    ].join("\n");
  }
  if (step.style === "testing") {
    return [
      `You are the ${step.title.toLowerCase()} step for a ${categoryLabel.toLowerCase()} workflow.`,
      step.goal,
      "Use the tests tool when appropriate, prefer actionable coverage, and keep the result tied to real project risks.",
      "End with [STEP_DONE] when the testing pass is complete."
    ].join("\n");
  }
  if (step.style === "review" || step.style === "docs") {
    return [
      `You are the ${step.title.toLowerCase()} step for a ${categoryLabel.toLowerCase()} workflow.`,
      step.goal,
      "Use the accumulated workflow context to produce a final, high-signal output.",
      "End with [STEP_DONE] when the handoff is complete."
    ].join("\n");
  }
  return [
    `You are the ${step.title.toLowerCase()} step for a ${categoryLabel.toLowerCase()} workflow.`,
    step.goal,
    "Use repository context and prior workflow outputs to move the task forward.",
    "Keep the output concise, actionable, and aligned to the current step.",
    "End with [STEP_DONE] when the step output is complete."
  ].join("\n");
}

function createPromptTemplate(step: StepSeed, categoryLabel: string): string {
  if (step.style === "implementation" || step.style === "debug" || step.style === "testing") {
    return implementationPrompt(categoryLabel, step.title, step.goal);
  }
  if (step.style === "review" || step.style === "docs") {
    return reviewPrompt(categoryLabel, step.title, step.goal);
  }
  return planPrompt(categoryLabel, step.title, step.goal);
}

function createStep(step: StepSeed, categoryLabel: string): WorkflowStep {
  return {
    id: step.id,
    role: step.role,
    provider: step.provider,
    model: step.model,
    reasoningEffort: step.reasoningEffort ?? DEFAULT_REASONING,
    systemPrompt: createSystemPrompt(step, categoryLabel),
    promptTemplate: createPromptTemplate(step, categoryLabel),
    tools: step.tools,
    ...(step.gate ? { gate: step.gate } : {}),
    ...(step.memory ? { memory: step.memory } : {})
  };
}

function workflowFileName(category: BuiltinWorkflowCategory, audience: BuiltinWorkflowAudience): string {
  return `${category}.${audience}.yaml`;
}

function makeTemplate(seed: TemplateSeed): BuiltinWorkflowTemplate {
  const categoryLabel = BUILTIN_WORKFLOW_CATEGORY_LABELS[seed.category];
  const workflow = normalizeWorkflowModels({
    schemaVersion: 1,
    name: seed.name,
    description: seed.description,
    steps: seed.steps.map((step) => createStep(step, categoryLabel))
  });
  return {
    id: `${seed.category}.${seed.audience}`,
    fileName: workflowFileName(seed.category, seed.audience),
    category: seed.category,
    audience: seed.audience,
    name: seed.name,
    description: seed.description,
    workflow
  };
}

function cloneTemplate(template: BuiltinWorkflowTemplate): BuiltinWorkflowTemplate {
  return {
    ...template,
    workflow: JSON.parse(JSON.stringify(template.workflow)) as WorkflowDefinition
  };
}

const BASE_TEMPLATES: TemplateSeed[] = [
  {
    category: "base_software_development",
    audience: "openai_subscriber",
    name: "Base Software Development - OpenAI subscriber",
    description: "Plan, implement backend and UI, debug, test, and finish with review/docs using OpenAI subscriber models.",
    steps: [
      phase("plan", "Plan", "planner", "plan", "codex_subscription", "gpt-5.4", "Produce the implementation plan.", ["filesystem"], { memory: PLAN_MEMORY }),
      phase("backend", "Backend", "engineer", "implementation", "codex_subscription", "gpt-5.3-codex", "Build the core logic and backend implementation.", ["filesystem", "git"], { gate: makeGate(true, true) }),
      phase("ui", "UI", "ui_engineer", "implementation", "codex_subscription", "gpt-5.3-codex", "Implement the user-facing interface and related interaction flows.", ["filesystem", "git"], { gate: makeGate(true, false) }),
      phase("debug", "Debug", "debugger", "debug", "codex_subscription", "gpt-5.3-codex", "Debug defects and stabilize the current implementation.", ["filesystem", "tests"], { gate: makeGate(false, true) }),
      phase("agentic_testing", "Agentic testing", "tester", "testing", "codex_subscription", "gpt-5.2", "Run regression-focused agentic testing and surface unresolved risks.", ["filesystem", "tests"], { gate: makeGate(false, true) }),
      phase("review_docs", "Review/docs", "reviewer", "review", "codex_subscription", "gpt-5.4", "Review the final state and produce concise handoff documentation.", ["filesystem", "tests"])
    ]
  },
  {
    category: "base_software_development",
    audience: "claude_subscriber",
    name: "Base Software Development - Claude subscriber",
    description: "Plan, implement backend and UI, debug, test, and finish with review/docs using Claude subscriber models.",
    steps: [
      phase("plan", "Plan", "planner", "plan", "claude_subscription", "opus-4.6", "Produce the implementation plan.", ["filesystem"], { memory: PLAN_MEMORY }),
      phase("backend", "Backend", "engineer", "implementation", "claude_subscription", "sonnet-4.6", "Build the core logic and backend implementation.", ["filesystem", "git"], { gate: makeGate(true, true) }),
      phase("ui", "UI", "ui_engineer", "implementation", "claude_subscription", "sonnet-4.6", "Implement the user-facing interface and related interaction flows.", ["filesystem", "git"], { gate: makeGate(true, false) }),
      phase("debug", "Debug", "debugger", "debug", "claude_subscription", "opus-4.6", "Debug defects and stabilize the current implementation.", ["filesystem", "tests"], { gate: makeGate(false, true) }),
      phase("testing", "Testing", "tester", "testing", "claude_subscription", "sonnet-4.6", "Run targeted verification and regression testing.", ["filesystem", "tests"], { gate: makeGate(false, true) }),
      phase("review_docs", "Review/docs", "reviewer", "review", "claude_subscription", "opus-4.6", "Review the final state and produce concise handoff documentation.", ["filesystem", "tests"])
    ]
  },
  {
    category: "base_software_development",
    audience: "api_router_user",
    name: "Base Software Development - API/router user",
    description: "Use Gemini for planning, Codex for implementation, Claude for UI intent and final review/docs.",
    steps: [
      phase("plan", "Plan", "planner", "plan", "openrouter", "Gemini 3.1 Pro", "Produce the implementation plan.", ["filesystem"], { memory: PLAN_MEMORY }),
      phase("backend", "Backend", "engineer", "implementation", "codex_api", "gpt-5.4", "Build the core logic and backend implementation.", ["filesystem", "git"], { gate: makeGate(true, true) }),
      phase("ui_intent", "UI intent", "designer", "analysis", "openrouter", "Claude Opus 4.6", "Define the UI intent, flow, and interaction direction before integration.", ["filesystem"]),
      phase("ui_integrate", "UI integrate", "ui_engineer", "implementation", "codex_api", "gpt-5.4", "Integrate the approved UI intent into the actual repository implementation.", ["filesystem", "git"], { gate: makeGate(true, false) }),
      phase("debug", "Debug", "debugger", "debug", "codex_api", "gpt-5.3-codex", "Debug defects and stabilize the current implementation.", ["filesystem", "tests"], { gate: makeGate(false, true) }),
      phase("agentic_testing", "Agentic testing", "tester", "testing", "codex_api", "gpt-5.2", "Run regression-focused agentic testing and surface unresolved risks.", ["filesystem", "tests"], { gate: makeGate(false, true) }),
      phase("review_docs", "Final review/docs", "reviewer", "review", "openrouter", "Claude Opus 4.6", "Review the final state and produce concise handoff documentation.", ["filesystem", "tests"])
    ]
  }
];

const GAME_TEMPLATES: TemplateSeed[] = [
  {
    category: "game_development",
    audience: "openai_subscriber",
    name: "Game Development - OpenAI subscriber",
    description: "Concept, systems, gameplay, HUD, debug/perf, and balance/docs using OpenAI subscriber models.",
    steps: [
      phase("concept", "Concept", "planner", "plan", "codex_subscription", "gpt-5.4", "Define the concept, loop, and player-facing direction.", ["filesystem"], { memory: PLAN_MEMORY }),
      phase("systems", "Systems", "architect", "analysis", "codex_subscription", "gpt-5.2", "Design the major gameplay systems and technical structure.", ["filesystem"]),
      phase("gameplay", "Gameplay code", "engineer", "implementation", "codex_subscription", "gpt-5.3-codex", "Implement gameplay code and core mechanics.", ["filesystem", "git"], { gate: makeGate(true, true) }),
      phase("ui_hud", "UI/HUD", "ui_engineer", "implementation", "codex_subscription", "gpt-5.3-codex", "Implement HUD, menus, and game-facing UI.", ["filesystem", "git"], { gate: makeGate(true, false) }),
      phase("debug_perf", "Debug/perf", "debugger", "debug", "codex_subscription", "gpt-5.3-codex", "Debug gameplay issues and improve runtime performance.", ["filesystem", "tests"], { gate: makeGate(false, true) }),
      phase("balance_docs", "Balance/docs", "reviewer", "review", "codex_subscription", "gpt-5.4", "Review balance implications and write the final notes.", ["filesystem", "tests"])
    ]
  },
  {
    category: "game_development",
    audience: "claude_subscriber",
    name: "Game Development - Claude subscriber",
    description: "Concept, systems, gameplay, HUD, debug/perf, and balance/docs using Claude subscriber models.",
    steps: [
      phase("concept", "Concept", "planner", "plan", "claude_subscription", "opus-4.6", "Define the concept, loop, and player-facing direction.", ["filesystem"], { memory: PLAN_MEMORY }),
      phase("systems", "Systems", "architect", "analysis", "claude_subscription", "opus-4.6", "Design the major gameplay systems and technical structure.", ["filesystem"]),
      phase("gameplay", "Gameplay", "engineer", "implementation", "claude_subscription", "sonnet-4.6", "Implement gameplay code and core mechanics.", ["filesystem", "git"], { gate: makeGate(true, true) }),
      phase("ui_hud", "UI/HUD", "ui_engineer", "implementation", "claude_subscription", "sonnet-4.6", "Implement HUD, menus, and game-facing UI.", ["filesystem", "git"], { gate: makeGate(true, false) }),
      phase("debug_perf", "Debug/perf", "debugger", "debug", "claude_subscription", "opus-4.6", "Debug gameplay issues and improve runtime performance.", ["filesystem", "tests"], { gate: makeGate(false, true) }),
      phase("balance_docs", "Balance/docs", "reviewer", "review", "claude_subscription", "opus-4.6", "Review balance implications and write the final notes.", ["filesystem", "tests"])
    ]
  },
  {
    category: "game_development",
    audience: "api_router_user",
    name: "Game Development - API/router user",
    description: "Use Gemini for concept/system design, Codex for gameplay implementation, and Claude for player experience and docs.",
    steps: [
      phase("concept", "Concept", "planner", "plan", "openrouter", "Gemini 3.1 Pro", "Define the concept, loop, and player-facing direction.", ["filesystem"], { memory: PLAN_MEMORY }),
      phase("systems", "Systems", "architect", "analysis", "openrouter", "Gemini 3.1 Pro", "Design the major gameplay systems and technical structure.", ["filesystem"]),
      phase("gameplay", "Gameplay", "engineer", "implementation", "codex_api", "gpt-5.4", "Implement gameplay code and core mechanics.", ["filesystem", "git"], { gate: makeGate(true, true) }),
      phase("player_experience", "UI/player experience", "designer", "analysis", "openrouter", "Claude Opus 4.6", "Define the player-facing flow, feel, and interface direction before code edits.", ["filesystem"]),
      phase("ui_hud", "UI/HUD integration", "ui_engineer", "implementation", "codex_api", "gpt-5.4", "Implement the player experience decisions in repo code and HUD assets.", ["filesystem", "git"], { gate: makeGate(true, false) }),
      phase("debug_perf", "Debug/perf", "debugger", "debug", "codex_api", "gpt-5.3-codex", "Debug gameplay issues and improve runtime performance.", ["filesystem", "tests"], { gate: makeGate(false, true) }),
      phase("balance_docs", "Balance/docs", "reviewer", "review", "openrouter", "Claude Opus 4.6", "Review balance implications and write the final notes.", ["filesystem", "tests"])
    ]
  }
];

const WEB_TEMPLATES: TemplateSeed[] = [
  {
    category: "web_development",
    audience: "openai_subscriber",
    name: "Web Development - OpenAI subscriber",
    description: "Product/UX, backend, frontend, polish, debug, testing, and final docs using OpenAI subscriber models.",
    steps: [
      phase("product_ux", "Product/UX", "planner", "plan", "codex_subscription", "gpt-5.4", "Define the product and UX direction.", ["filesystem"], { memory: PLAN_MEMORY }),
      phase("backend", "Backend", "engineer", "implementation", "codex_subscription", "gpt-5.3-codex", "Implement backend logic, APIs, and data handling.", ["filesystem", "git"], { gate: makeGate(true, true) }),
      phase("frontend", "Frontend", "ui_engineer", "implementation", "codex_subscription", "gpt-5.3-codex", "Implement the frontend experience and client-side behavior.", ["filesystem", "git"], { gate: makeGate(true, false) }),
      phase("ui_refinement", "UI refinement", "designer", "implementation", "codex_subscription", "gpt-5.4", "Refine visual details, states, and interaction polish.", ["filesystem", "git"], { gate: makeGate(true, false) }),
      phase("debug", "Debug", "debugger", "debug", "codex_subscription", "gpt-5.3-codex", "Debug defects and stabilize the web app.", ["filesystem", "tests"], { gate: makeGate(false, true) }),
      phase("testing_review", "Testing/review", "tester", "testing", "codex_subscription", "gpt-5.2", "Run focused testing and verification before final sign-off.", ["filesystem", "tests"], { gate: makeGate(false, true) }),
      phase("docs", "Final docs", "reviewer", "docs", "codex_subscription", "gpt-5.4", "Write the final review/docs summary and handoff.", ["filesystem", "tests"])
    ]
  },
  {
    category: "web_development",
    audience: "claude_subscriber",
    name: "Web Development - Claude subscriber",
    description: "Product/UX, backend, frontend, visual polish, debug, and final docs using Claude subscriber models.",
    steps: [
      phase("product_ux", "Product/UX", "planner", "plan", "claude_subscription", "opus-4.6", "Define the product and UX direction.", ["filesystem"], { memory: PLAN_MEMORY }),
      phase("backend", "Backend", "engineer", "implementation", "claude_subscription", "sonnet-4.6", "Implement backend logic, APIs, and data handling.", ["filesystem", "git"], { gate: makeGate(true, true) }),
      phase("frontend", "Frontend", "ui_engineer", "implementation", "claude_subscription", "sonnet-4.6", "Implement the frontend experience and client-side behavior.", ["filesystem", "git"], { gate: makeGate(true, false) }),
      phase("visual_polish", "Visual polish", "designer", "implementation", "claude_subscription", "opus-4.6", "Refine visuals, hierarchy, and design polish.", ["filesystem", "git"], { gate: makeGate(true, false) }),
      phase("debug", "Debug", "debugger", "debug", "claude_subscription", "sonnet-4.6", "Debug defects and stabilize the web app.", ["filesystem", "tests"], { gate: makeGate(false, true) }),
      phase("review_docs", "Review/docs", "reviewer", "review", "claude_subscription", "opus-4.6", "Write the final review/docs summary and handoff.", ["filesystem", "tests"])
    ]
  },
  {
    category: "web_development",
    audience: "api_router_user",
    name: "Web Development - API/router user",
    description: "Use Claude for product and final review, Codex for backend/frontend, and Claude for polish by default.",
    steps: [
      phase("product_ux", "Product/UX", "planner", "plan", "openrouter", "Claude Opus 4.6", "Define the product and UX direction.", ["filesystem"], { memory: PLAN_MEMORY }),
      phase("backend", "Backend", "engineer", "implementation", "codex_api", "gpt-5.4", "Implement backend logic, APIs, and data handling.", ["filesystem", "git"], { gate: makeGate(true, true) }),
      phase("frontend", "Frontend", "ui_engineer", "implementation", "codex_api", "gpt-5.4", "Implement the frontend experience and client-side behavior.", ["filesystem", "git"], { gate: makeGate(true, false) }),
      phase("visual_polish", "Visual polish/SVG", "designer", "implementation", "openrouter", "Claude Opus 4.6", "Refine visuals, SVG assets, hierarchy, and design polish.", ["filesystem", "git"], { gate: makeGate(true, false) }),
      phase("debug", "Debug", "debugger", "debug", "codex_api", "gpt-5.3-codex", "Debug defects and stabilize the web app.", ["filesystem", "tests"], { gate: makeGate(false, true) }),
      phase("agentic_testing", "Agentic testing", "tester", "testing", "codex_api", "gpt-5.2", "Run focused testing and verification before final sign-off.", ["filesystem", "tests"], { gate: makeGate(false, true) }),
      phase("review_docs", "Final review/docs", "reviewer", "review", "openrouter", "Claude Opus 4.6", "Write the final review/docs summary and handoff.", ["filesystem", "tests"])
    ]
  }
];

const DEBUG_TEMPLATES: TemplateSeed[] = [
  {
    category: "debugging_workflow",
    audience: "openai_subscriber",
    name: "Debugging Workflow - OpenAI subscriber",
    description: "Reproduce, diagnose, design a patch, fix, regression test, and review using OpenAI subscriber models.",
    steps: [
      phase("repro", "Repro", "debugger", "debug", "codex_subscription", "gpt-5.3-codex", "Reproduce and characterize the failure clearly.", ["filesystem", "tests"], { gate: makeGate(false, true) }),
      phase("diagnose", "Diagnose", "debugger", "analysis", "codex_subscription", "gpt-5.3-codex", "Determine the most likely root cause using the real codebase.", ["filesystem", "tests"]),
      phase("patch_design", "Patch design", "planner", "plan", "codex_subscription", "gpt-5.2", "Design the patch strategy and minimal change set.", ["filesystem"]),
      phase("fix", "Fix", "engineer", "implementation", "codex_subscription", "gpt-5.3-codex", "Implement the fix in code.", ["filesystem", "git"], { gate: makeGate(true, true) }),
      phase("regression_testing", "Agentic regression testing", "tester", "testing", "codex_subscription", "gpt-5.2", "Run regression-focused testing around the fix.", ["filesystem", "tests"], { gate: makeGate(false, true) }),
      phase("review", "Review", "reviewer", "review", "codex_subscription", "gpt-5.4", "Review the fix quality, remaining risk, and handoff.", ["filesystem", "tests"])
    ]
  },
  {
    category: "debugging_workflow",
    audience: "claude_subscriber",
    name: "Debugging Workflow - Claude subscriber",
    description: "Reproduce, diagnose, design a patch, fix, regression test, and review using Claude subscriber models.",
    steps: [
      phase("repro", "Repro", "debugger", "debug", "claude_subscription", "sonnet-4.6", "Reproduce and characterize the failure clearly.", ["filesystem", "tests"], { gate: makeGate(false, true) }),
      phase("diagnose", "Diagnose", "debugger", "analysis", "claude_subscription", "opus-4.6", "Determine the most likely root cause using the real codebase.", ["filesystem", "tests"]),
      phase("patch_plan", "Patch plan", "planner", "plan", "claude_subscription", "opus-4.6", "Design the patch strategy and minimal change set.", ["filesystem"]),
      phase("fix", "Fix", "engineer", "implementation", "claude_subscription", "sonnet-4.6", "Implement the fix in code.", ["filesystem", "git"], { gate: makeGate(true, true) }),
      phase("regression_tests", "Regression tests", "tester", "testing", "claude_subscription", "sonnet-4.6", "Run regression-focused testing around the fix.", ["filesystem", "tests"], { gate: makeGate(false, true) }),
      phase("review", "Review", "reviewer", "review", "claude_subscription", "opus-4.6", "Review the fix quality, remaining risk, and handoff.", ["filesystem", "tests"])
    ]
  },
  {
    category: "debugging_workflow",
    audience: "api_router_user",
    name: "Debugging Workflow - API/router user",
    description: "Use Codex for repro/fix/testing and Claude for root-cause analysis and final review.",
    steps: [
      phase("repro", "Repro", "debugger", "debug", "codex_api", "gpt-5.3-codex", "Reproduce and characterize the failure clearly.", ["filesystem", "tests"], { gate: makeGate(false, true) }),
      phase("root_cause", "Root cause", "debugger", "analysis", "openrouter", "Claude Opus 4.6", "Determine the most likely root cause using the real codebase.", ["filesystem", "tests"]),
      phase("patch_plan", "Patch plan", "planner", "plan", "openrouter", "Claude Opus 4.6", "Design the patch strategy and minimal change set.", ["filesystem"]),
      phase("fix", "Fix", "engineer", "implementation", "codex_api", "gpt-5.3-codex", "Implement the fix in code.", ["filesystem", "git"], { gate: makeGate(true, true) }),
      phase("regression_testing", "Agentic regression testing", "tester", "testing", "codex_api", "gpt-5.2", "Run regression-focused testing around the fix.", ["filesystem", "tests"], { gate: makeGate(false, true) }),
      phase("review", "Final review", "reviewer", "review", "openrouter", "Claude Opus 4.6", "Review the fix quality, remaining risk, and handoff.", ["filesystem", "tests"])
    ]
  }
];

const TESTER_TEMPLATES: TemplateSeed[] = [
  {
    category: "tester_qa",
    audience: "openai_subscriber",
    name: "Tester / QA - OpenAI subscriber",
    description: "Risk plan, unit tests, E2E tests, triage, edge cases, and sign-off using OpenAI subscriber models.",
    steps: [
      phase("risk_plan", "Risk plan", "planner", "plan", "codex_subscription", "gpt-5.2", "Identify the highest-risk areas and the best test strategy.", ["filesystem"], { memory: PLAN_MEMORY }),
      phase("unit_tests", "Unit tests", "tester", "implementation", "codex_subscription", "gpt-5.3-codex", "Add or improve focused unit tests.", ["filesystem", "git"], { gate: makeGate(true, false) }),
      phase("e2e_tests", "E2E tests", "tester", "implementation", "codex_subscription", "gpt-5.3-codex", "Add or improve end-to-end tests for the core user paths.", ["filesystem", "git"], { gate: makeGate(true, false) }),
      phase("failure_triage", "Failure triage", "debugger", "debug", "codex_subscription", "gpt-5.2", "Triage failures, classify causes, and identify the right next action.", ["filesystem", "tests"], { gate: makeGate(false, true) }),
      phase("edge_cases", "Edge cases", "tester", "testing", "codex_subscription", "gpt-5.4", "Probe for edge cases and missing coverage.", ["filesystem", "tests"], { gate: makeGate(false, true) }),
      phase("sign_off", "Sign-off", "reviewer", "review", "codex_subscription", "gpt-5.4", "Produce final QA sign-off with risks and recommendations.", ["filesystem", "tests"])
    ]
  },
  {
    category: "tester_qa",
    audience: "claude_subscriber",
    name: "Tester / QA - Claude subscriber",
    description: "Risk plan, unit tests, E2E tests, triage, edge cases, and sign-off using Claude subscriber models.",
    steps: [
      phase("risk_plan", "Risk plan", "planner", "plan", "claude_subscription", "opus-4.6", "Identify the highest-risk areas and the best test strategy.", ["filesystem"], { memory: PLAN_MEMORY }),
      phase("unit_tests", "Unit tests", "tester", "implementation", "claude_subscription", "sonnet-4.6", "Add or improve focused unit tests.", ["filesystem", "git"], { gate: makeGate(true, false) }),
      phase("e2e_tests", "E2E tests", "tester", "implementation", "claude_subscription", "sonnet-4.6", "Add or improve end-to-end tests for the core user paths.", ["filesystem", "git"], { gate: makeGate(true, false) }),
      phase("failure_triage", "Failure triage", "debugger", "debug", "claude_subscription", "opus-4.6", "Triage failures, classify causes, and identify the right next action.", ["filesystem", "tests"], { gate: makeGate(false, true) }),
      phase("edge_cases", "Edge cases", "tester", "testing", "claude_subscription", "opus-4.6", "Probe for edge cases and missing coverage.", ["filesystem", "tests"], { gate: makeGate(false, true) }),
      phase("sign_off", "Sign-off", "reviewer", "review", "claude_subscription", "opus-4.6", "Produce final QA sign-off with risks and recommendations.", ["filesystem", "tests"])
    ]
  },
  {
    category: "tester_qa",
    audience: "api_router_user",
    name: "Tester / QA - API/router user",
    description: "Use Claude for planning/edge cases/sign-off and Codex for unit, E2E, and triage work.",
    steps: [
      phase("risk_plan", "Risk plan", "planner", "plan", "openrouter", "Claude Opus 4.6", "Identify the highest-risk areas and the best test strategy.", ["filesystem"], { memory: PLAN_MEMORY }),
      phase("unit_tests", "Unit tests", "tester", "implementation", "codex_api", "gpt-5-mini", "Add or improve focused unit tests.", ["filesystem", "git"], { gate: makeGate(true, false) }),
      phase("e2e_tests", "E2E tests", "tester", "implementation", "codex_api", "gpt-5.4", "Add or improve end-to-end tests for the core user paths.", ["filesystem", "git"], { gate: makeGate(true, false) }),
      phase("failure_triage", "Failure triage", "debugger", "debug", "codex_api", "gpt-5.2", "Triage failures, classify causes, and identify the right next action.", ["filesystem", "tests"], { gate: makeGate(false, true) }),
      phase("edge_cases", "Edge cases", "tester", "testing", "openrouter", "Claude Opus 4.6", "Probe for edge cases and missing coverage.", ["filesystem", "tests"], { gate: makeGate(false, true) }),
      phase("sign_off", "Sign-off", "reviewer", "review", "openrouter", "Claude Opus 4.6", "Produce final QA sign-off with risks and recommendations.", ["filesystem", "tests"])
    ]
  }
];

const SECURITY_TEMPLATES: TemplateSeed[] = [
  {
    category: "security",
    audience: "openai_subscriber",
    name: "Security - OpenAI subscriber",
    description: "Threat model, audit, prioritization, remediation, secure patching, and write-up using OpenAI subscriber models.",
    steps: [
      phase("threat_model", "Threat model", "planner", "plan", "codex_subscription", "gpt-5.4", "Define the threat model and attack surface.", ["filesystem"], { memory: PLAN_MEMORY }),
      phase("audit", "Audit", "security_reviewer", "analysis", "codex_subscription", "gpt-5.4", "Audit the code and configuration for concrete security issues.", ["filesystem", "tests"]),
      phase("prioritize", "Prioritize", "planner", "analysis", "codex_subscription", "gpt-5.2", "Prioritize issues by severity, exploitability, and remediation value.", ["filesystem"]),
      phase("remediation_design", "Remediation design", "architect", "plan", "codex_subscription", "gpt-5.2", "Design the remediation plan with minimal-risk changes.", ["filesystem"]),
      phase("secure_patch", "Secure patch", "engineer", "implementation", "codex_subscription", "gpt-5.3-codex", "Implement the highest-value secure patch work.", ["filesystem", "git"], { gate: makeGate(true, true) }),
      phase("write_up", "Write-up", "reviewer", "review", "codex_subscription", "gpt-5.4", "Produce the security review write-up and residual risk summary.", ["filesystem", "tests"])
    ]
  },
  {
    category: "security",
    audience: "claude_subscriber",
    name: "Security - Claude subscriber",
    description: "Threat model, audit, prioritization, remediation, secure patching, and write-up using Claude subscriber models.",
    steps: [
      phase("threat_model", "Threat model", "planner", "plan", "claude_subscription", "opus-4.6", "Define the threat model and attack surface.", ["filesystem"], { memory: PLAN_MEMORY }),
      phase("audit", "Audit", "security_reviewer", "analysis", "claude_subscription", "opus-4.6", "Audit the code and configuration for concrete security issues.", ["filesystem", "tests"]),
      phase("prioritize", "Prioritize", "planner", "analysis", "claude_subscription", "opus-4.6", "Prioritize issues by severity, exploitability, and remediation value.", ["filesystem"]),
      phase("remediation_design", "Remediation", "architect", "plan", "claude_subscription", "opus-4.6", "Design the remediation plan with minimal-risk changes.", ["filesystem"]),
      phase("secure_patch", "Patch", "engineer", "implementation", "claude_subscription", "sonnet-4.6", "Implement the highest-value secure patch work.", ["filesystem", "git"], { gate: makeGate(true, true) }),
      phase("write_up", "Write-up", "reviewer", "review", "claude_subscription", "opus-4.6", "Produce the security review write-up and residual risk summary.", ["filesystem", "tests"])
    ]
  },
  {
    category: "security",
    audience: "api_router_user",
    name: "Security - API/router user",
    description: "Use Claude for security analysis and Codex for secure patch implementation.",
    steps: [
      phase("threat_model", "Threat model", "planner", "plan", "openrouter", "Claude Opus 4.6", "Define the threat model and attack surface.", ["filesystem"], { memory: PLAN_MEMORY }),
      phase("audit", "Audit", "security_reviewer", "analysis", "openrouter", "Claude Opus 4.6", "Audit the code and configuration for concrete security issues.", ["filesystem", "tests"]),
      phase("prioritize", "Prioritize", "planner", "analysis", "openrouter", "Claude Opus 4.6", "Prioritize issues by severity, exploitability, and remediation value.", ["filesystem"]),
      phase("remediation_design", "Remediation design", "architect", "plan", "openrouter", "Claude Opus 4.6", "Design the remediation plan with minimal-risk changes.", ["filesystem"]),
      phase("secure_patch", "Patch", "engineer", "implementation", "codex_api", "gpt-5.4", "Implement the highest-value secure patch work.", ["filesystem", "git"], { gate: makeGate(true, true) }),
      phase("write_up", "Security review/write-up", "reviewer", "review", "openrouter", "Claude Opus 4.6", "Produce the security review write-up and residual risk summary.", ["filesystem", "tests"])
    ]
  }
];

const DATA_TEMPLATES: TemplateSeed[] = [
  {
    category: "data_science",
    audience: "openai_subscriber",
    name: "Data Science - OpenAI subscriber",
    description: "Framing, exploration, cleaning, modeling, interpretation, and memo using OpenAI subscriber models.",
    steps: [
      phase("framing", "Framing", "planner", "plan", "codex_subscription", "gpt-5.4", "Frame the analytical question, success criteria, and deliverable.", ["filesystem"], { memory: PLAN_MEMORY }),
      phase("exploration", "Exploration", "researcher", "analysis", "codex_subscription", "gpt-5.2", "Explore the available data, assumptions, and likely signal.", ["filesystem"]),
      phase("cleaning_sql", "Cleaning/SQL", "engineer", "implementation", "codex_subscription", "gpt-5.3-codex", "Implement data cleaning, shaping, and SQL work.", ["filesystem", "git"], { gate: makeGate(true, true) }),
      phase("modeling_code", "Modeling code", "engineer", "implementation", "codex_subscription", "gpt-5.3-codex", "Implement the modeling or analysis code.", ["filesystem", "git"], { gate: makeGate(true, true) }),
      phase("interpretation", "Interpretation", "researcher", "review", "codex_subscription", "gpt-5.4", "Interpret the results, uncertainty, and practical implications.", ["filesystem", "tests"]),
      phase("memo", "Memo", "reviewer", "docs", "codex_subscription", "gpt-5.2", "Write the final memo and recommended next actions.", ["filesystem"])
    ]
  },
  {
    category: "data_science",
    audience: "claude_subscriber",
    name: "Data Science - Claude subscriber",
    description: "Framing, exploration, cleaning, modeling, interpretation, and memo using Claude subscriber models.",
    steps: [
      phase("framing", "Framing", "planner", "plan", "claude_subscription", "opus-4.6", "Frame the analytical question, success criteria, and deliverable.", ["filesystem"], { memory: PLAN_MEMORY }),
      phase("exploration", "Exploration", "researcher", "analysis", "claude_subscription", "opus-4.6", "Explore the available data, assumptions, and likely signal.", ["filesystem"]),
      phase("cleaning_sql", "Cleaning/SQL", "engineer", "implementation", "claude_subscription", "sonnet-4.6", "Implement data cleaning, shaping, and SQL work.", ["filesystem", "git"], { gate: makeGate(true, true) }),
      phase("modeling", "Modeling", "engineer", "implementation", "claude_subscription", "sonnet-4.6", "Implement the modeling or analysis code.", ["filesystem", "git"], { gate: makeGate(true, true) }),
      phase("interpretation", "Interpretation", "researcher", "review", "claude_subscription", "opus-4.6", "Interpret the results, uncertainty, and practical implications.", ["filesystem", "tests"]),
      phase("memo", "Memo", "reviewer", "docs", "claude_subscription", "opus-4.6", "Write the final memo and recommended next actions.", ["filesystem"])
    ]
  },
  {
    category: "data_science",
    audience: "api_router_user",
    name: "Data Science - API/router user",
    description: "Use Gemini for framing/exploration, Codex for data work, and Claude for interpretation and memo.",
    steps: [
      phase("framing", "Framing", "planner", "plan", "openrouter", "Gemini 3.1 Pro", "Frame the analytical question, success criteria, and deliverable.", ["filesystem"], { memory: PLAN_MEMORY }),
      phase("exploration", "Exploration", "researcher", "analysis", "openrouter", "Gemini 3.1 Pro", "Explore the available data, assumptions, and likely signal.", ["filesystem"]),
      phase("cleaning_sql", "Cleaning/SQL", "engineer", "implementation", "codex_api", "gpt-5.4", "Implement data cleaning, shaping, and SQL work.", ["filesystem", "git"], { gate: makeGate(true, true) }),
      phase("modeling", "Modeling", "engineer", "implementation", "codex_api", "gpt-5.4", "Implement the modeling or analysis code.", ["filesystem", "git"], { gate: makeGate(true, true) }),
      phase("interpretation", "Interpretation", "researcher", "review", "openrouter", "Claude Opus 4.6", "Interpret the results, uncertainty, and practical implications.", ["filesystem", "tests"]),
      phase("memo", "Memo", "reviewer", "docs", "openrouter", "Claude Opus 4.6", "Write the final memo and recommended next actions.", ["filesystem"])
    ]
  }
];

const DOCS_TEMPLATES: TemplateSeed[] = [
  {
    category: "documentation",
    audience: "openai_subscriber",
    name: "Documentation - OpenAI subscriber",
    description: "Audience/IA, source digestion, drafting, accuracy, consistency, and final polish using OpenAI subscriber models.",
    steps: [
      phase("audience_ia", "Audience/IA", "planner", "plan", "codex_subscription", "gpt-5.4", "Define the audience, structure, and information architecture.", ["filesystem"], { memory: PLAN_MEMORY }),
      phase("source_digestion", "Source digestion", "researcher", "analysis", "codex_subscription", "gpt-5.2", "Digest the source material and extract the relevant facts.", ["filesystem"]),
      phase("draft", "Draft", "writer", "docs", "codex_subscription", "gpt-5-mini", "Write the first draft of the documentation.", ["filesystem", "git"], { gate: makeGate(true, false) }),
      phase("accuracy", "Accuracy pass", "reviewer", "review", "codex_subscription", "gpt-5.4", "Verify factual and technical accuracy against the source material.", ["filesystem", "tests"]),
      phase("consistency", "Consistency", "reviewer", "review", "codex_subscription", "gpt-5.2", "Align terminology, voice, and structure across the document set.", ["filesystem"]),
      phase("final_polish", "Final polish", "writer", "docs", "codex_subscription", "gpt-5.4", "Apply final polish and produce the handoff summary.", ["filesystem"])
    ]
  },
  {
    category: "documentation",
    audience: "claude_subscriber",
    name: "Documentation - Claude subscriber",
    description: "Audience/IA, source digestion, drafting, accuracy, consistency, and final polish using Claude subscriber models.",
    steps: [
      phase("audience_ia", "Audience/IA", "planner", "plan", "claude_subscription", "opus-4.6", "Define the audience, structure, and information architecture.", ["filesystem"], { memory: PLAN_MEMORY }),
      phase("source_digestion", "Source digestion", "researcher", "analysis", "claude_subscription", "opus-4.6", "Digest the source material and extract the relevant facts.", ["filesystem"]),
      phase("draft", "Draft", "writer", "docs", "claude_subscription", "sonnet-4.6", "Write the first draft of the documentation.", ["filesystem", "git"], { gate: makeGate(true, false) }),
      phase("accuracy", "Accuracy", "reviewer", "review", "claude_subscription", "opus-4.6", "Verify factual and technical accuracy against the source material.", ["filesystem", "tests"]),
      phase("consistency", "Consistency", "reviewer", "review", "claude_subscription", "opus-4.6", "Align terminology, voice, and structure across the document set.", ["filesystem"]),
      phase("final_polish", "Final polish", "writer", "docs", "claude_subscription", "opus-4.6", "Apply final polish and produce the handoff summary.", ["filesystem"])
    ]
  },
  {
    category: "documentation",
    audience: "api_router_user",
    name: "Documentation - API/router user",
    description: "Use Claude for audience/polish, Sonnet for source digestion, and GPT-5.4 for drafting and accuracy.",
    steps: [
      phase("audience_ia", "Audience/IA", "planner", "plan", "openrouter", "Claude Opus 4.6", "Define the audience, structure, and information architecture.", ["filesystem"], { memory: PLAN_MEMORY }),
      phase("source_digestion", "Source digestion", "researcher", "analysis", "openrouter", "Claude Sonnet 4.6", "Digest the source material and extract the relevant facts.", ["filesystem"]),
      phase("draft", "Draft", "writer", "docs", "codex_api", "gpt-5.4", "Write the first draft of the documentation.", ["filesystem", "git"], { gate: makeGate(true, false) }),
      phase("accuracy", "Accuracy", "reviewer", "review", "codex_api", "gpt-5.4", "Verify factual and technical accuracy against the source material.", ["filesystem", "tests"]),
      phase("consistency", "Consistency", "reviewer", "review", "openrouter", "Claude Opus 4.6", "Align terminology, voice, and structure across the document set.", ["filesystem"]),
      phase("final_polish", "Final polish", "writer", "docs", "openrouter", "Claude Opus 4.6", "Apply final polish and produce the handoff summary.", ["filesystem"])
    ]
  }
];

function buildTemplateSeeds(): TemplateSeed[] {
  return [
    ...BASE_TEMPLATES,
    ...GAME_TEMPLATES,
    ...WEB_TEMPLATES,
    ...DEBUG_TEMPLATES,
    ...TESTER_TEMPLATES,
    ...SECURITY_TEMPLATES,
    ...DATA_TEMPLATES,
    ...DOCS_TEMPLATES
  ];
}

const BUILTIN_TEMPLATES = buildTemplateSeeds().map(makeTemplate);

export function listBuiltinWorkflowTemplates(): BuiltinWorkflowTemplate[] {
  return BUILTIN_TEMPLATES.map(cloneTemplate);
}

export function findBuiltinWorkflowTemplateById(id: string): BuiltinWorkflowTemplate | null {
  const match = BUILTIN_TEMPLATES.find((template) => template.id === id);
  return match ? cloneTemplate(match) : null;
}

export function inferBuiltinWorkflowAudience(config: OrchestraConfig): BuiltinWorkflowAudience | null {
  const providers = config.providers;
  const hasApiCredential = [
    providers.codexApi?.apiKey,
    providers.openaiCompatible?.apiKey,
    providers.openrouter?.apiKey,
    providers.nim?.apiKey,
    providers.openai?.apiKey,
    providers.anthropic?.apiKey,
    providers.google?.apiKey
  ].some((value) => typeof value === "string" && value.trim().length > 0);
  if (hasApiCredential) {
    return "api_router_user";
  }
  const codexEnabled = providers.codexSubscription?.enabled !== false;
  const claudeEnabled = providers.claudeSubscription?.enabled !== false;
  if (codexEnabled && !claudeEnabled) {
    return "openai_subscriber";
  }
  if (claudeEnabled && !codexEnabled) {
    return "claude_subscriber";
  }
  return null;
}

export function classifyBuiltinWorkflowCategory(task: string): BuiltinWorkflowCategory {
  const normalized = task.toLowerCase();
  let bestCategory: BuiltinWorkflowCategory = "base_software_development";
  let bestScore = 0;
  for (const [category, hints] of Object.entries(CATEGORY_CLASSIFIER_HINTS) as Array<
    [BuiltinWorkflowCategory, Array<string | RegExp>]
  >) {
    let score = 0;
    for (const hint of hints) {
      if (typeof hint === "string") {
        if (normalized.includes(hint.toLowerCase())) {
          score += hint.includes(" ") ? 4 : 2;
        }
      } else if (hint.test(task)) {
        score += 4;
      }
    }
    if (category === "debugging_workflow" && /fix|bug|broken|error|issue/.test(normalized)) {
      score += 3;
    }
    if (category === "tester_qa" && /test|coverage|qa|regression/.test(normalized)) {
      score += 3;
    }
    if (category === "security" && /auth|security|vuln|attack|secret|permission/.test(normalized)) {
      score += 4;
    }
    if (category === "documentation" && /docs?|readme|guide|manual|reference/.test(normalized)) {
      score += 4;
    }
    if (score > bestScore) {
      bestScore = score;
      bestCategory = category;
    }
  }
  return bestCategory;
}

export function classifyBuiltinWorkflowTemplate(
  task: string,
  audience: BuiltinWorkflowAudience
): BuiltinWorkflowTemplate {
  const category = classifyBuiltinWorkflowCategory(task);
  const match = BUILTIN_TEMPLATES.find((template) => template.category === category && template.audience === audience);
  if (!match) {
    throw new Error(`Missing built-in workflow for ${category}/${audience}`);
  }
  return cloneTemplate(match);
}

export async function ensureBuiltinWorkflowFiles(workflowsDir: string): Promise<void> {
  await fs.mkdir(workflowsDir, { recursive: true });
  const existing = new Set(await fs.readdir(workflowsDir));
  for (const template of BUILTIN_TEMPLATES) {
    if (existing.has(template.fileName)) {
      continue;
    }
    const fullPath = path.join(workflowsDir, template.fileName);
    await fs.writeFile(fullPath, yamlStringify(template.workflow), "utf8");
  }
}
