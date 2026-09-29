import assert from "node:assert/strict";
import { test } from "node:test";
import { EXAMPLE_WORKFLOW_YAML } from "./paths";
import { parseWorkflowYaml } from "./workflow";

test("EXAMPLE_WORKFLOW_YAML parses as a valid workflow", () => {
  const workflow = parseWorkflowYaml(EXAMPLE_WORKFLOW_YAML);
  assert.ok(workflow.name.length > 0);
  assert.ok(workflow.steps.length > 0);
  for (const step of workflow.steps) {
    assert.ok(step.id.length > 0);
    assert.ok(step.promptTemplate.length > 0);
  }
});
