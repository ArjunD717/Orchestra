import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { ensurePathWithinRoot } from "./security";
import { ApprovalRequest } from "./types";

export interface ToolContext {
  repoRoot: string;
  requestApproval: (req: ApprovalRequest) => Promise<boolean>;
  safeMode: boolean;
}

async function runProcess(command: string, cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.on("error", (err) => {
      resolve({ code: 1, stdout: "", stderr: String(err) });
    });
  });
}

export class FilesystemTool {
  constructor(private readonly repoRoot: string) {}

  async readFile(relativePath: string, maxBytes = 24_000): Promise<string> {
    const target = ensurePathWithinRoot(this.repoRoot, path.join(this.repoRoot, relativePath));
    const raw = await fs.readFile(target, "utf8");
    return raw.slice(0, maxBytes);
  }

  async listDirectory(relativePath = "."): Promise<string[]> {
    const target = ensurePathWithinRoot(this.repoRoot, path.join(this.repoRoot, relativePath));
    const entries = await fs.readdir(target, { withFileTypes: true });
    return entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => `${e.name}${e.isDirectory() ? "/" : ""}`);
  }
}

export class GitTool {
  constructor(private readonly ctx: ToolContext) {}

  async run(command: string): Promise<{ ok: boolean; output: string }> {
    const approved = await this.ctx.requestApproval({
      title: "Approve external command",
      message: `Run git command?\n${command}`
    });
    if (!approved) {
      return { ok: false, output: "Rejected by user." };
    }
    const result = await runProcess(command, this.ctx.repoRoot);
    if (result.code !== 0 && /not recognized|not found|ENOENT/i.test(result.stderr)) {
      return { ok: false, output: "Git appears unavailable on this machine." };
    }
    return { ok: result.code === 0, output: `${result.stdout}${result.stderr}`.trim() };
  }
}

export class TestsTool {
  constructor(private readonly ctx: ToolContext) {}

  async run(command: string): Promise<{ ok: boolean; output: string }> {
    if (this.ctx.safeMode) {
      const approved = await this.ctx.requestApproval({
        title: "Approve test execution",
        message: `Run test command?\n${command}`
      });
      if (!approved) {
        return { ok: false, output: "Rejected by user." };
      }
    }
    const result = await runProcess(command, this.ctx.repoRoot);
    return { ok: result.code === 0, output: `${result.stdout}${result.stderr}`.trim() };
  }
}

export class ShellTool {
  constructor(private readonly ctx: ToolContext) {}

  async run(command: string): Promise<{ ok: boolean; output: string }> {
    const approved = await this.ctx.requestApproval({
      title: "Approve shell command",
      message: `Shell tool is disabled by default.\nRun command?\n${command}`
    });
    if (!approved) {
      return { ok: false, output: "Rejected by user." };
    }
    const result = await runProcess(command, this.ctx.repoRoot);
    return { ok: result.code === 0, output: `${result.stdout}${result.stderr}`.trim() };
  }
}
