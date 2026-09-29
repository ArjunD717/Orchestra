#!/usr/bin/env node
import { ensureOrchestraHome, getOrchestraPaths } from "./paths";
import { runSnakeGame } from "./snake";
import { bootstrapAndRun } from "./ui";

async function main(): Promise<void> {
  const args = process.argv.slice(2).map((arg) => arg.trim().toLowerCase());
  if (args.includes("snake") || args.includes("--snake")) {
    await runSnakeGame();
    return;
  }

  const paths = getOrchestraPaths();
  await ensureOrchestraHome(paths);
  await bootstrapAndRun(paths);
}

void main();
