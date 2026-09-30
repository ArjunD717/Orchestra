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

const PROCESS_TIMEOUT_MS = 60_000;
const STREAM_CAP_BYTES = 256 * 1024;

function matchDestructiveGit(command: string): string | null {
  const cmd = ` ${command} `;
  if (/\bclean\b/.test(cmd) && /(^|\s)-[a-zA-Z]*[fd][a-zA-Z]*(\s|$)/.test(cmd)) return "clean";
  if (/\breset\b/.test(cmd) && /--hard/.test(cmd)) return "reset --hard";
  if (/\bcheckout\b\s+--\s+\./.test(command) || /\bcheckout\b\s+\./.test(command)) return "checkout";
  if (/\bpush\b/.test(cmd) && (/--force/.test(cmd) || /(^|\s)-f(\s|$)/.test(cmd))) return "push";
  if (/\bbranch\b/.test(cmd) && /(^|\s)-D(\s|$)/.test(cmd)) return "branch -D";
  return null;
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
    let timedOut = false;
    let truncated = false;
    let settled = false;
    const finish = (result: { code: number; stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const onData = (chunk: unknown, kind: "stdout" | "stderr") => {
      const text = String(chunk);
      if (kind === "stdout") {
        if (stdout.length < STREAM_CAP_BYTES) {
          stdout += text.slice(0, STREAM_CAP_BYTES - stdout.length);
        }
        if (stdout.length >= STREAM_CAP_BYTES && !truncated) {
          truncated = true;
          try { child.kill(); } catch { /* ignore */ }
        }
      } else {
        if (stderr.length < STREAM_CAP_BYTES) {
          stderr += text.slice(0, STREAM_CAP_BYTES - stderr.length);
        }
        if (stderr.length >= STREAM_CAP_BYTES && !truncated) {
          truncated = true;
          try { child.kill(); } catch { /* ignore */ }
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* ignore */ }
    }, PROCESS_TIMEOUT_MS);
    child.stdout?.on("data", (d) => {
      onData(d, "stdout");
    });
    child.stderr?.on("data", (d) => {
      onData(d, "stderr");
    });
    child.on("close", (code) => {
      if (timedOut) {
        finish({ code: code ?? 1, stdout, stderr: `${stderr}\n[orchestra] command timed out after 60000ms`.trim() });
      } else if (truncated) {
        finish({ code: code ?? 1, stdout: `${stdout}\n[orchestra] output truncated at 256KB`, stderr });
      } else {
        finish({ code: code ?? 1, stdout, stderr });
      }
    });
    child.on("error", (err) => {
      finish({ code: 1, stdout: "", stderr: String(err) });
    });
  });
}

export class FilesystemTool {
  constructor(private readonly repoRoot: string) {}

  async readFile(relativePath: string, maxBytes = 24_000): Promise<string> {
    const target = ensurePathWithinRoot(this.repoRoot, path.join(this.repoRoot, relativePath));
    const st = await fs.stat(target);
    if (st.isDirectory()) {
      return `(binary or directory, skipped: ${relativePath} is a directory)`;
    }
    const toRead = Math.min(maxBytes, st.size);
    const handle = await fs.open(target, "r");
    try {
      const buf = Buffer.alloc(Math.max(0, toRead));
      await handle.read(buf, 0, buf.length, 0);
      if (buf.includes(0)) {
        return `(binary or directory, skipped: ${relativePath} appears to be binary)`;
      }
      return buf.toString("utf8").slice(0, maxBytes);
    } finally {
      await handle.close();
    }
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
    const denied = matchDestructiveGit(command);
    if (denied) {
      return { ok: false, output: `Refused: destructive git command denied (${denied}).` };
    }
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
