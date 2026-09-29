import { WorkflowDefinition } from "./types";

function canonicalKey(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const CODEX_MODEL_ALIASES: Record<string, string> = {
  gpt53codex: "gpt-5.3-codex",
  gpt53codexhigh: "gpt-5.3-codex",
  gpt53codexmax: "gpt-5.3-codex",
  gpt52codex: "gpt-5.2-codex",
  gpt52: "gpt-5.2",
  gpt52high: "gpt-5.2",
  gpt52xhigh: "gpt-5.2",
  gpt51codexmax: "gpt-5.1-codex-max",
  gpt51codexmini: "gpt-5.1-codex-mini",
  gpt5: "gpt-5.3-codex"
};

export function normalizeModelForProvider(provider: string, model: string): { model: string; changed: boolean } {
  const providerKey = provider.trim().toLowerCase();
  const modelTrimmed = model.trim();
  if (!modelTrimmed) {
    return { model: modelTrimmed, changed: false };
  }

  if (providerKey === "codex_subscription" || providerKey === "codex_api") {
    const mapped = CODEX_MODEL_ALIASES[canonicalKey(modelTrimmed)];
    if (mapped) {
      return { model: mapped, changed: mapped !== modelTrimmed };
    }
  }

  return { model: modelTrimmed, changed: modelTrimmed !== model };
}

export function normalizeWorkflowModels(workflow: WorkflowDefinition): WorkflowDefinition {
  return {
    ...workflow,
    steps: workflow.steps.map((step) => {
      const normalized = normalizeModelForProvider(step.provider, step.model);
      if (!normalized.changed) {
        return step;
      }
      return {
        ...step,
        model: normalized.model
      };
    })
  };
}
