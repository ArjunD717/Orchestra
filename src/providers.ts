import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { ModelRequest, OrchestraConfig } from "./types";

export interface ModelAdapter {
  stream(request: ModelRequest): AsyncGenerator<string>;
  generate(request: ModelRequest): Promise<string>;
}

export interface ProviderRegistry {
  getAdapter(provider: string): ModelAdapter;
}

interface OpenAICompatibleOptions {
  providerName: string;
  baseUrl?: string;
  apiKey?: string;
  defaultModel?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

const OUTPUT_CAP_CHARS = 1_000_000;
const OUTPUT_TRUNCATED_SUFFIX = "\n[orchestra] output truncated at 1MB";
function appendOutputCapped(current: string, chunk: string): string {
  if (current.length >= OUTPUT_CAP_CHARS) {
    return current;
  }
  if (current.length + chunk.length <= OUTPUT_CAP_CHARS) {
    return current + chunk;
  }
  return current + chunk.slice(0, OUTPUT_CAP_CHARS - current.length);
}

interface SpawnResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  error?: string;
  timedOut?: boolean;
}

const activeModelChildren = new Set<ReturnType<typeof spawn>>();
let activeModelChildrenHooksInstalled = false;

function terminateChildTree(child: ReturnType<typeof spawn>): void {
  try {
    if (process.platform === "win32" && child.pid) {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true
      });
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    // best effort
  }
}

function ensureActiveModelChildHooks(): void {
  if (activeModelChildrenHooksInstalled) {
    return;
  }
  activeModelChildrenHooksInstalled = true;
  const shutdown = (): void => {
    for (const child of [...activeModelChildren]) {
      terminateChildTree(child);
    }
  };
  process.once("exit", shutdown);
  process.once("SIGINT", () => {
    shutdown();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    shutdown();
    process.exit(143);
  });
}

function trackActiveModelChild(child: ReturnType<typeof spawn>): void {
  ensureActiveModelChildHooks();
  activeModelChildren.add(child);
  const remove = (): void => {
    activeModelChildren.delete(child);
  };
  child.once("close", remove);
  child.once("error", remove);
}

interface CodexAuthTokens {
  accessToken: string;
  refreshToken?: string;
  accountId?: string;
  authPath: string;
}

export interface ProviderCommandTrace {
  tool: string;
  command: string;
  output: string;
  ok: boolean;
  exitCode?: number | null;
  status?: string;
  source: string;
}

export interface ProviderTraceSnapshot {
  toolCalls: ProviderCommandTrace[];
  rawJsonEvents: string[];
}

const providerTraceStore = new Map<string, ProviderTraceSnapshot>();

function providerTraceKey(runId: string, stepId: string): string {
  return `${runId}::${stepId}`;
}

function stashProviderTrace(
  request: ModelRequest,
  trace: ProviderTraceSnapshot
): void {
  providerTraceStore.set(providerTraceKey(request.runId, request.stepId), trace);
  if (providerTraceStore.size > 50) {
    const oldest = providerTraceStore.keys().next();
    if (!oldest.done) {
      providerTraceStore.delete(oldest.value);
    }
  }
}

export function consumeProviderTrace(runId: string, stepId: string): ProviderTraceSnapshot {
  const key = providerTraceKey(runId, stepId);
  const found = providerTraceStore.get(key);
  providerTraceStore.delete(key);
  return found ?? { toolCalls: [], rawJsonEvents: [] };
}

function resolveModelCommandTimeoutMs(): number | null {
  const raw = process.env.ORCHESTRA_MODEL_CMD_TIMEOUT_MS?.trim();
  if (!raw) {
    return null;
  }
  if (raw === "0" || raw.toLowerCase() === "off" || raw.toLowerCase() === "false") {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function hashText(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 12);
}

function deterministicMockOutput(request: ModelRequest): string {
  const h = hashText(`${request.provider}:${request.model}:${request.prompt}`);
  const shortPrompt = request.prompt.slice(0, 120).replace(/\s+/g, " ").trim();
  const wantsDiff = /unified diff|```diff|patch|code changes/i.test(request.prompt);
  if (wantsDiff) {
    return [
      `Orchestra mock response (${request.provider}/${request.model}) [${h}]`,
      "",
      "```diff",
      "--- a/ORCHESTRA_NOTES.md",
      "+++ b/ORCHESTRA_NOTES.md",
      "@@ -0,0 +1,3 @@",
      "+# Orchestra Notes",
      `+Run: ${request.runId}`,
      `+Step: ${request.stepId}`,
      "```"
    ].join("\n");
  }
  return [
    `Orchestra mock response (${request.provider}/${request.model}) [${h}]`,
    `Summary: ${shortPrompt}`,
    "Action: Continue with safe, explicit approvals."
  ].join("\n");
}

function fallbackWithReason(request: ModelRequest, reason: string): string {
  return [
    `[orchestra] Provider "${request.provider}" unavailable: ${reason}`,
    deterministicMockOutput(request)
  ].join("\n\n");
}

function stripAnsi(input: string): string {
  return input.replace(/\u001b\[[0-9;]*m/g, "");
}

async function* streamByWord(text: string): AsyncGenerator<string> {
  const words = text.split(/(\s+)/g);
  for (const token of words) {
    yield token;
    await new Promise((r) => setTimeout(r, 6));
  }
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const out: string[] = [];
    for (const item of content) {
      if (typeof item === "string") {
        out.push(item);
      } else if (item && typeof item === "object") {
        const maybe = item as Record<string, unknown>;
        if (typeof maybe.text === "string") {
          out.push(maybe.text);
        }
      }
    }
    return out.join("");
  }
  return "";
}

function extractResponsesOutputText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.output_text === "string" && record.output_text.trim()) {
    return record.output_text;
  }

  const output = Array.isArray(record.output) ? record.output : [];
  const chunks: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const itemRec = item as Record<string, unknown>;
    const content = Array.isArray(itemRec.content) ? itemRec.content : [];
    for (const c of content) {
      if (!c || typeof c !== "object") {
        continue;
      }
      const cRec = c as Record<string, unknown>;
      const directText = typeof cRec.text === "string" ? cRec.text : "";
      if (directText) {
        chunks.push(directText);
        continue;
      }
      const nestedText = typeof cRec.output_text === "string" ? cRec.output_text : "";
      if (nestedText) {
        chunks.push(nestedText);
      }
    }
  }
  return chunks.join("").trim();
}

const CODEX_REFRESH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_REFRESH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_TOKEN_REFRESH_INTERVAL_DAYS = 8;

function safeIsoDate(isoLike: string | undefined): Date | null {
  if (!isoLike) {
    return null;
  }
  const d = new Date(isoLike);
  return Number.isNaN(d.getTime()) ? null : d;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) {
    return null;
  }
  const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
  try {
    const json = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function extractAccountIdFromIdToken(idTokenRaw: unknown): string | undefined {
  if (typeof idTokenRaw !== "string" || !idTokenRaw.trim()) {
    return undefined;
  }
  const payload = decodeJwtPayload(idTokenRaw);
  if (!payload) {
    return undefined;
  }
  const authObj = payload["https://api.openai.com/auth"];
  if (authObj && typeof authObj === "object") {
    const rec = authObj as Record<string, unknown>;
    const accountId = rec.chatgpt_account_id;
    if (typeof accountId === "string" && accountId.trim()) {
      return accountId.trim();
    }
  }
  return undefined;
}

function resolveCodexHome(): string {
  const raw = process.env.CODEX_HOME?.trim();
  if (raw) {
    return raw;
  }
  return path.join(os.homedir(), ".codex");
}

function isCommandInvocationError(text: string): boolean {
  return /ENOENT|EINVAL|ENOTDIR|EPERM|EACCES|Access is denied|not recognized as an internal or external command|No such file or directory|Unable to execute command/i.test(
    text
  );
}

async function runProcess(command: string, args: string[], input = ""): Promise<SpawnResult> {
  return runProcessWithOptions(command, args, input);
}

async function runProcessWithOptions(
  command: string,
  args: string[],
  input = "",
  options?: { cwd?: string }
): Promise<SpawnResult> {
  const timeoutMs = resolveModelCommandTimeoutMs();
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let finished = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: SpawnResult): void => {
      if (finished) {
        return;
      }
      finished = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
        cwd: options?.cwd
      });
      trackActiveModelChild(child);
    } catch (error) {
      finish({
        ok: false,
        code: 1,
        stdout,
        stderr,
        error: error instanceof Error ? error.message : String(error)
      });
      return;
    }
    if (timeoutMs !== null) {
      timer = setTimeout(() => {
        timedOut = true;
        terminateChildTree(child);
      }, timeoutMs);
    }

    child.stdout?.on("data", (d) => {
      stdout = appendOutputCapped(stdout, String(d));
    });
    child.stderr?.on("data", (d) => {
      stderr = appendOutputCapped(stderr, String(d));
    });
    child.on("close", (code) => {
      if (stdout.length >= OUTPUT_CAP_CHARS) {
        stdout += OUTPUT_TRUNCATED_SUFFIX;
      }
      if (stderr.length >= OUTPUT_CAP_CHARS) {
        stderr += OUTPUT_TRUNCATED_SUFFIX;
      }
      if (timedOut) {
        const timeoutLabel = timeoutMs ?? 0;
        finish({
          ok: false,
          code: 1,
          stdout,
          stderr: `${stderr}\n[orchestra] command timed out after ${timeoutLabel}ms`,
          timedOut: true
        });
        return;
      }
      finish({
        ok: code === 0,
        code: code ?? 1,
        stdout,
        stderr
      });
    });
    child.on("error", (err) => {
      finish({
        ok: false,
        code: 1,
        stdout,
        stderr,
        error: String(err)
      });
    });
    if (input) {
      child.stdin?.write(input);
    }
    child.stdin?.end();
  });
}

function quoteForShell(arg: string): string {
  if (process.platform === "win32") {
    const escaped = arg.replace(/"/g, '\\"');
    if (/[\s^&|<>()%!"]/g.test(escaped)) {
      return `"${escaped}"`;
    }
    return escaped;
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

async function runProcessViaShell(
  command: string,
  args: string[],
  input = "",
  options?: { cwd?: string }
): Promise<SpawnResult> {
  const fullCommand = [quoteForShell(command), ...args.map((a) => quoteForShell(a))].join(" ");
  const timeoutMs = resolveModelCommandTimeoutMs();
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let finished = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: SpawnResult): void => {
      if (finished) {
        return;
      }
      finished = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      if (process.platform === "win32") {
        child = spawn("cmd.exe", ["/d", "/s", "/c", fullCommand], {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          shell: false,
          cwd: options?.cwd
        });
      } else {
        child = spawn(fullCommand, {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          shell: true,
          cwd: options?.cwd
        });
      }
      trackActiveModelChild(child);
    } catch (error) {
      finish({
        ok: false,
        code: 1,
        stdout,
        stderr,
        error: error instanceof Error ? error.message : String(error)
      });
      return;
    }
    if (timeoutMs !== null) {
      timer = setTimeout(() => {
        timedOut = true;
        terminateChildTree(child);
      }, timeoutMs);
    }
    child.stdout?.on("data", (d) => {
      stdout = appendOutputCapped(stdout, String(d));
    });
    child.stderr?.on("data", (d) => {
      stderr = appendOutputCapped(stderr, String(d));
    });
    child.on("close", (code) => {
      if (stdout.length >= OUTPUT_CAP_CHARS) {
        stdout += OUTPUT_TRUNCATED_SUFFIX;
      }
      if (stderr.length >= OUTPUT_CAP_CHARS) {
        stderr += OUTPUT_TRUNCATED_SUFFIX;
      }
      if (timedOut) {
        const timeoutLabel = timeoutMs ?? 0;
        finish({
          ok: false,
          code: 1,
          stdout,
          stderr: `${stderr}\n[orchestra] command timed out after ${timeoutLabel}ms`,
          timedOut: true
        });
        return;
      }
      finish({
        ok: code === 0,
        code: code ?? 1,
        stdout,
        stderr
      });
    });
    child.on("error", (err) => {
      finish({
        ok: false,
        code: 1,
        stdout,
        stderr,
        error: String(err)
      });
    });
    if (input) {
      child.stdin?.write(input);
    }
    child.stdin?.end();
  });
}

async function runWithCommandCandidates(
  command: string,
  args: string[],
  input = "",
  options?: { cwd?: string }
): Promise<SpawnResult> {
  const candidates: string[] = [];
  const trimmed = command.trim();
  if (trimmed) {
    candidates.push(trimmed);
    if (process.platform === "win32" && !/\.(cmd|exe|bat)$/i.test(trimmed)) {
      candidates.push(`${trimmed}.cmd`);
      candidates.push(`${trimmed}.exe`);
    }
  }

  let lastResult: SpawnResult | null = null;
  for (const candidate of candidates) {
    const result = await runProcessWithOptions(candidate, args, input, options);
    const stderrCombined = `${result.error || ""} ${result.stderr || ""}`;
    const missingExe = isCommandInvocationError(stderrCombined);
    if (!missingExe) {
      return result;
    }
    lastResult = result;
  }

  return (
    lastResult ?? {
      ok: false,
      code: 1,
      stdout: "",
      stderr: `Unable to execute command: ${command}`
    }
  );
}

async function runWithShellCandidates(
  command: string,
  args: string[],
  input = "",
  options?: { cwd?: string }
): Promise<SpawnResult> {
  const candidates: string[] = [];
  const trimmed = command.trim();
  if (trimmed) {
    candidates.push(trimmed);
    if (process.platform === "win32" && !/\.(cmd|exe|bat)$/i.test(trimmed)) {
      candidates.push(`${trimmed}.cmd`);
      candidates.push(`${trimmed}.exe`);
    }
  }

  let lastResult: SpawnResult | null = null;
  for (const candidate of candidates) {
    const result = await runProcessViaShell(candidate, args, input, options);
    const missingExe = isCommandInvocationError(`${result.error || ""} ${result.stderr || ""}`);
    if (!missingExe) {
      return result;
    }
    lastResult = result;
  }
  return (
    lastResult ?? {
      ok: false,
      code: 1,
      stdout: "",
      stderr: `Unable to execute command: ${command}`
    }
  );
}

class MockAdapter implements ModelAdapter {
  async *stream(request: ModelRequest): AsyncGenerator<string> {
    const text = await this.generate(request);
    yield* streamByWord(text);
  }

  async generate(request: ModelRequest): Promise<string> {
    return deterministicMockOutput(request);
  }
}

class OpenAICompatibleAdapter implements ModelAdapter {
  constructor(private readonly options: OpenAICompatibleOptions) {}

  private modelFor(request: ModelRequest): string {
    return request.model || this.options.defaultModel || "gpt-4.1-mini";
  }

  private endpoint(): string {
    const base = (this.options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    return `${base}/chat/completions`;
  }

  private authHeaders(): Record<string, string> {
    return {
      ...(this.options.headers ?? {}),
      ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {})
    };
  }

  async *stream(request: ModelRequest): AsyncGenerator<string> {
    if (!this.options.apiKey) {
      yield* streamByWord(fallbackWithReason(request, "API key is not configured."));
      return;
    }

    try {
      const payload: Record<string, unknown> = {
        model: this.modelFor(request),
        messages: [{ role: "user", content: request.prompt }],
        stream: true
      };
      if (request.reasoningEffort) {
        payload.reasoning_effort = request.reasoningEffort;
      }
      const response = await fetch(this.endpoint(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.authHeaders()
        },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        const body = await response.text();
        yield* streamByWord(
          fallbackWithReason(request, `HTTP ${response.status}. ${body.slice(0, 300)}`)
        );
        return;
      }
      if (!response.body) {
        yield* streamByWord(await this.generate(request));
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let emitted = false;

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let idx = buffer.indexOf("\n");
        while (idx >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          idx = buffer.indexOf("\n");
          if (!line.startsWith("data:")) {
            continue;
          }
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") {
            continue;
          }
          try {
            const parsed = JSON.parse(payload) as Record<string, unknown>;
            const choices = parsed.choices as Array<Record<string, unknown>> | undefined;
            const first = choices?.[0];
            const delta = first?.delta as Record<string, unknown> | undefined;
            const chunk = extractMessageText(delta?.content);
            if (chunk) {
              emitted = true;
              yield chunk;
            }
          } catch {
            continue;
          }
        }
      }

      if (!emitted) {
        yield* streamByWord(await this.generate(request));
      }
    } catch (error) {
      yield* streamByWord(
        fallbackWithReason(request, error instanceof Error ? error.message : String(error))
      );
    }
  }

  async generate(request: ModelRequest): Promise<string> {
    if (!this.options.apiKey) {
      return fallbackWithReason(request, "API key is not configured.");
    }

    try {
      const payload: Record<string, unknown> = {
        model: this.modelFor(request),
        messages: [{ role: "user", content: request.prompt }]
      };
      if (request.reasoningEffort) {
        payload.reasoning_effort = request.reasoningEffort;
      }
      const response = await fetch(this.endpoint(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.authHeaders()
        },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        const body = await response.text();
        return fallbackWithReason(request, `HTTP ${response.status}. ${body.slice(0, 300)}`);
      }
      const json = (await response.json()) as Record<string, unknown>;
      const choices = json.choices as Array<Record<string, unknown>> | undefined;
      const first = choices?.[0];
      const message = first?.message as Record<string, unknown> | undefined;
      const text = extractMessageText(message?.content);
      if (text) {
        return text;
      }
      const outputText = typeof json.output_text === "string" ? json.output_text : "";
      if (outputText) {
        return outputText;
      }
      return JSON.stringify(json);
    } catch (error) {
      return fallbackWithReason(request, error instanceof Error ? error.message : String(error));
    }
  }
}

class OpenAIResponsesAdapter implements ModelAdapter {
  constructor(private readonly options: OpenAICompatibleOptions) {}

  private modelFor(request: ModelRequest): string {
    return request.model || this.options.defaultModel || "gpt-5.3-codex";
  }

  private endpoint(): string {
    const base = (this.options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    return `${base}/responses`;
  }

  private authHeaders(): Record<string, string> {
    return {
      ...(this.options.headers ?? {}),
      ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {})
    };
  }

  async *stream(request: ModelRequest): AsyncGenerator<string> {
    const text = await this.generate(request);
    yield* streamByWord(text);
  }

  async generate(request: ModelRequest): Promise<string> {
    if (this.options.enabled === false) {
      return fallbackWithReason(request, `${this.options.providerName} adapter is disabled in settings.`);
    }
    if (!this.options.apiKey) {
      return fallbackWithReason(request, "API key is not configured.");
    }
    try {
      const payload: Record<string, unknown> = {
        model: this.modelFor(request),
        input: request.prompt
      };
      if (request.reasoningEffort) {
        payload.reasoning = { effort: request.reasoningEffort };
      }
      const response = await fetch(this.endpoint(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.authHeaders()
        },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        const body = await response.text();
        return fallbackWithReason(request, `HTTP ${response.status}. ${body.slice(0, 500)}`);
      }
      const json = (await response.json()) as Record<string, unknown>;
      const text = extractResponsesOutputText(json);
      if (text) {
        return text;
      }
      return JSON.stringify(json);
    } catch (error) {
      return fallbackWithReason(request, error instanceof Error ? error.message : String(error));
    }
  }
}

class CodexSubscriptionApiAdapter implements ModelAdapter {
  constructor(
    private readonly options: {
      providerName: string;
      baseUrl?: string;
      defaultModel?: string;
      enabled?: boolean;
      headers?: Record<string, string>;
    }
  ) {}

  private modelFor(request: ModelRequest): string {
    return request.model || this.options.defaultModel || "gpt-5.3-codex";
  }

  private endpoint(): string {
    const base = (this.options.baseUrl ?? "https://chatgpt.com/backend-api/codex").replace(/\/+$/, "");
    return `${base}/responses`;
  }

  async *stream(request: ModelRequest): AsyncGenerator<string> {
    const text = await this.generate(request);
    yield* streamByWord(text);
  }

  private async readCodexAuthJson(): Promise<{
    authPath: string;
    parsed: Record<string, unknown>;
  }> {
    const authPath = path.join(resolveCodexHome(), "auth.json");
    const raw = await fs.readFile(authPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Invalid auth.json format.");
    }
    return { authPath, parsed: parsed as Record<string, unknown> };
  }

  private shouldRefresh(lastRefresh: Date | null): boolean {
    if (!lastRefresh) {
      return false;
    }
    const ageMs = Date.now() - lastRefresh.getTime();
    const maxAgeMs = CODEX_TOKEN_REFRESH_INTERVAL_DAYS * 24 * 60 * 60 * 1000;
    return ageMs > maxAgeMs;
  }

  private async refreshCodexToken(
    authPath: string,
    parsed: Record<string, unknown>,
    refreshToken: string
  ): Promise<CodexAuthTokens> {
    const response = await fetch(CODEX_REFRESH_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        client_id: CODEX_REFRESH_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken
      })
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Token refresh failed (HTTP ${response.status}): ${body.slice(0, 220)}`);
    }

    const refreshed = (await response.json()) as Record<string, unknown>;
    const refreshedAccess =
      typeof refreshed.access_token === "string" ? refreshed.access_token.trim() : "";
    if (!refreshedAccess) {
      throw new Error("Token refresh response missing access_token.");
    }
    const refreshedRefresh =
      typeof refreshed.refresh_token === "string" ? refreshed.refresh_token.trim() : "";
    const refreshedIdToken =
      typeof refreshed.id_token === "string" ? refreshed.id_token.trim() : "";

    const tokensRaw =
      parsed.tokens && typeof parsed.tokens === "object" ? (parsed.tokens as Record<string, unknown>) : {};
    const updatedTokens: Record<string, unknown> = {
      ...tokensRaw,
      access_token: refreshedAccess
    };
    if (refreshedRefresh) {
      updatedTokens.refresh_token = refreshedRefresh;
    }
    if (refreshedIdToken) {
      updatedTokens.id_token = refreshedIdToken;
    }

    const updatedAuth: Record<string, unknown> = {
      ...parsed,
      tokens: updatedTokens,
      last_refresh: new Date().toISOString()
    };
    await fs.writeFile(authPath, JSON.stringify(updatedAuth, null, 2), "utf8");

    const accountId =
      (typeof updatedTokens.account_id === "string" && updatedTokens.account_id.trim()) ||
      extractAccountIdFromIdToken(updatedTokens.id_token);
    return {
      accessToken: refreshedAccess,
      refreshToken:
        (refreshedRefresh || (typeof updatedTokens.refresh_token === "string" ? updatedTokens.refresh_token : "")).trim() ||
        undefined,
      accountId: typeof accountId === "string" && accountId.trim() ? accountId.trim() : undefined,
      authPath
    };
  }

  private async loadSubscriptionTokens(): Promise<CodexAuthTokens> {
    const { authPath, parsed } = await this.readCodexAuthJson();
    const mode = typeof parsed.auth_mode === "string" ? parsed.auth_mode.trim().toLowerCase() : "";
    if (mode && mode !== "chatgpt" && mode !== "chatgptauthtokens") {
      throw new Error(`auth.json auth_mode="${mode}" is not ChatGPT subscription mode.`);
    }

    const tokens =
      parsed.tokens && typeof parsed.tokens === "object" ? (parsed.tokens as Record<string, unknown>) : null;
    if (!tokens) {
      throw new Error("auth.json has no tokens block. Run `codex login` first.");
    }

    const accessToken =
      typeof tokens.access_token === "string" ? tokens.access_token.trim() : "";
    const refreshToken =
      typeof tokens.refresh_token === "string" ? tokens.refresh_token.trim() : "";
    const accountIdFromField =
      typeof tokens.account_id === "string" ? tokens.account_id.trim() : "";
    const accountIdFromJwt = extractAccountIdFromIdToken(tokens.id_token);
    const accountId = accountIdFromField || accountIdFromJwt || undefined;
    const lastRefresh = safeIsoDate(typeof parsed.last_refresh === "string" ? parsed.last_refresh : undefined);

    if (!accessToken) {
      throw new Error("auth.json tokens.access_token is missing.");
    }

    if (this.shouldRefresh(lastRefresh) && refreshToken) {
      try {
        return await this.refreshCodexToken(authPath, parsed, refreshToken);
      } catch {
        // Best effort. Use existing access token and let 401 flow trigger explicit refresh/retry.
      }
    }

    return {
      accessToken,
      refreshToken: refreshToken || undefined,
      accountId,
      authPath
    };
  }

  private async requestResponses(
    request: ModelRequest,
    tokens: CodexAuthTokens
  ): Promise<{ ok: true; text: string } | { ok: false; status: number; body: string }> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tokens.accessToken}`,
      ...(this.options.headers ?? {})
    };
    if (tokens.accountId) {
      headers["ChatGPT-Account-ID"] = tokens.accountId;
    }

    const payload: Record<string, unknown> = {
      model: this.modelFor(request),
      instructions:
        "You are Orchestra, a local-first coding assistant. Follow the user request exactly and keep responses concise.",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: request.prompt }]
        }
      ],
      tools: [],
      tool_choice: "auto",
      parallel_tool_calls: true,
      store: false,
      stream: true,
      include: []
    };
    if (request.reasoningEffort) {
      payload.reasoning = { effort: request.reasoningEffort };
    }

    const response = await fetch(this.endpoint(), {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        body: (await response.text()).slice(0, 1000)
      };
    }
    const text = await this.readStreamingResponseText(response);
    return {
      ok: true,
      text: text || "[orchestra] Subscription API returned an empty completion."
    };
  }

  private async readStreamingResponseText(response: Response): Promise<string> {
    if (!response.body) {
      const raw = await response.text();
      try {
        const json = JSON.parse(raw) as Record<string, unknown>;
        return extractResponsesOutputText(json) || raw;
      } catch {
        return raw;
      }
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let deltaText = "";
    let doneText = "";
    let completedPayloadText = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf("\n");
      while (idx >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf("\n");
        if (!line.startsWith("data:")) {
          continue;
        }
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") {
          continue;
        }
        try {
          const event = JSON.parse(payload) as Record<string, unknown>;
          const type = typeof event.type === "string" ? event.type : "";
          if (type === "response.output_text.delta" && typeof event.delta === "string") {
            deltaText += event.delta;
          } else if (type === "response.output_text.done" && typeof event.text === "string") {
            doneText = event.text;
          } else if (type === "response.completed") {
            const completed = event.response as Record<string, unknown> | undefined;
            if (completed) {
              completedPayloadText = extractResponsesOutputText(completed);
            }
          }
        } catch {
          continue;
        }
      }
    }

    const trailing = buffer.trim();
    if (trailing.startsWith("data:")) {
      const payload = trailing.slice(5).trim();
      if (payload && payload !== "[DONE]") {
        try {
          const event = JSON.parse(payload) as Record<string, unknown>;
          const type = typeof event.type === "string" ? event.type : "";
          if (type === "response.output_text.delta" && typeof event.delta === "string") {
            deltaText += event.delta;
          } else if (type === "response.output_text.done" && typeof event.text === "string") {
            doneText = event.text;
          } else if (type === "response.completed") {
            const completed = event.response as Record<string, unknown> | undefined;
            if (completed) {
              completedPayloadText = extractResponsesOutputText(completed);
            }
          }
        } catch {
          // ignore malformed trailing payload
        }
      }
    }

    return deltaText || doneText || completedPayloadText;
  }

  async generate(request: ModelRequest): Promise<string> {
    if (this.options.enabled === false) {
      return fallbackWithReason(request, `${this.options.providerName} adapter is disabled in settings.`);
    }

    try {
      let auth = await this.loadSubscriptionTokens();
      const first = await this.requestResponses(request, auth);
      if (first.ok) {
        return first.text;
      }
      if (first.status === 401 && auth.refreshToken) {
        auth = await this.refreshCodexToken(
          auth.authPath,
          (await this.readCodexAuthJson()).parsed,
          auth.refreshToken
        );
        const retry = await this.requestResponses(request, auth);
        if (retry.ok) {
          return retry.text;
        }
        return fallbackWithReason(
          request,
          `Subscription API HTTP ${retry.status}. ${retry.body}`
        );
      }
      return fallbackWithReason(request, `Subscription API HTTP ${first.status}. ${first.body}`);
    } catch (error) {
      return fallbackWithReason(request, error instanceof Error ? error.message : String(error));
    }
  }
}

class CodexSubscriptionAdapter implements ModelAdapter {
  constructor(
    private readonly command = "codex",
    private readonly enabled = true
  ) {}

  async *stream(request: ModelRequest): AsyncGenerator<string> {
    const text = await this.generate(request);
    yield* streamByWord(text);
  }

  private parseJsonOutput(stdout: string): ProviderTraceSnapshot & { text: string } {
    const lines = stdout
      .split(/\r?\n/g)
      .map((l) => l.trim())
      .filter(Boolean);
    const chunks: string[] = [];
    const toolCalls: ProviderCommandTrace[] = [];
    const rawJsonEvents: string[] = [];
    const seenToolEvents = new Set<string>();

    for (const line of lines) {
      try {
        rawJsonEvents.push(line);
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const eventType = typeof parsed.type === "string" ? parsed.type : "";
        const msg = parsed.msg as Record<string, unknown> | undefined;
        const item = (msg?.item ?? parsed.item) as Record<string, unknown> | undefined;
        if (item?.type === "command_execution" && eventType === "item.completed") {
          const command = typeof item.command === "string" ? item.command : "";
          const output = typeof item.aggregated_output === "string" ? item.aggregated_output : "";
          const exitCode =
            typeof item.exit_code === "number" || item.exit_code === null ? (item.exit_code as number | null) : null;
          const status = typeof item.status === "string" ? item.status : "completed";
          const key = `${command}|${exitCode}|${status}|${output.slice(0, 200)}`;
          if (!seenToolEvents.has(key)) {
            seenToolEvents.add(key);
            toolCalls.push({
              tool: "shell",
              command,
              output,
              ok: exitCode === null ? status === "completed" : exitCode === 0,
              exitCode,
              status,
              source: "provider_codex_cli"
            });
          }
        }
        if (item?.type !== "agent_message") {
          continue;
        }
        const text = extractMessageText(item.text);
        if (text) {
          chunks.push(text);
        }
      } catch {
        continue;
      }
    }

    if (chunks.length > 0) {
      return { text: chunks[chunks.length - 1], toolCalls, rawJsonEvents };
    }
    return { text: stripAnsi(stdout).trim(), toolCalls, rawJsonEvents };
  }

  private isUnsupportedModelResult(result: SpawnResult): boolean {
    const blob = `${result.error || ""}\n${result.stderr || ""}\n${result.stdout || ""}`;
    return /model.+not supported|unsupported model|not supported when using codex/i.test(blob);
  }

  private fallbackModels(requested: string): string[] {
    const normalized = requested.trim().toLowerCase();
    if (normalized === "gpt-5.3-codex") {
      return ["gpt-5.2-codex", "gpt-5.1-codex-max", "gpt-5.1-codex-mini"];
    }
    if (normalized === "gpt-5.2-codex") {
      return ["gpt-5.1-codex-max", "gpt-5.1-codex-mini"];
    }
    if (normalized === "gpt-5.1-codex-max") {
      return ["gpt-5.1-codex-mini"];
    }
    return [];
  }

  async generate(request: ModelRequest): Promise<string> {
    if (!this.enabled) {
      return fallbackWithReason(request, "Codex subscription adapter is disabled in settings.");
    }
    const attempts = [request.model, ...this.fallbackModels(request.model)].filter(
      (m, i, arr) => m && arr.indexOf(m) === i
    );
    let lastResult: SpawnResult | null = null;
    let usedModel = request.model;
    for (let idx = 0; idx < attempts.length; idx += 1) {
      const modelAttempt = attempts[idx];
      const args = [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--model",
        modelAttempt
      ];
      let result = await runWithCommandCandidates(this.command, args, request.prompt, { cwd: request.cwd });
      if (!result.ok && isCommandInvocationError(`${result.error || ""} ${result.stderr || ""}`)) {
        result = await runWithShellCandidates(this.command, args, request.prompt, { cwd: request.cwd });
      }
      lastResult = result;
      usedModel = modelAttempt;
      if (result.ok) {
        const parsed = this.parseJsonOutput(result.stdout);
        stashProviderTrace(request, {
          toolCalls: parsed.toolCalls,
          rawJsonEvents: parsed.rawJsonEvents
        });
        const body = parsed.text || "[orchestra] Codex CLI returned no assistant text.";
        if (idx > 0) {
          return `[orchestra] Requested model "${request.model}" unavailable; fell back to "${modelAttempt}".\n\n${body}`;
        }
        return body;
      }
      if (!(this.isUnsupportedModelResult(result) && idx < attempts.length - 1)) {
        break;
      }
    }
    if (!lastResult || !lastResult.ok) {
      const reason = (
        lastResult?.error ||
        lastResult?.stderr ||
        (lastResult ? `exit code ${lastResult.code}` : "unknown error")
      ).slice(0, 400);
      const fallbackNote =
        usedModel !== request.model ? ` Last attempted fallback model: "${usedModel}".` : "";
      return `[orchestra] Codex CLI failed (${reason}). Ensure \`${this.command}\` is installed and logged in.${fallbackNote}`;
    }
    const parsed = this.parseJsonOutput(lastResult.stdout);
    stashProviderTrace(request, {
      toolCalls: parsed.toolCalls,
      rawJsonEvents: parsed.rawJsonEvents
    });
    return parsed.text || "[orchestra] Codex CLI returned no assistant text.";
  }
}

class ClaudeSubscriptionAdapter implements ModelAdapter {
  constructor(
    private readonly command = "claude",
    private readonly enabled = true
  ) {}

  async *stream(request: ModelRequest): AsyncGenerator<string> {
    const text = await this.generate(request);
    yield* streamByWord(text);
  }

  private parseJsonOutput(stdout: string): string {
    const lines = stdout
      .split(/\r?\n/g)
      .map((l) => l.trim())
      .filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const parsed = JSON.parse(lines[i]) as Record<string, unknown>;
        if (typeof parsed.result === "string" && parsed.result.trim()) {
          return parsed.result;
        }
      } catch {
        continue;
      }
    }
    return stripAnsi(stdout).trim();
  }

  async generate(request: ModelRequest): Promise<string> {
    if (!this.enabled) {
      return fallbackWithReason(request, "Claude subscription adapter is disabled in settings.");
    }

    let result = await runWithCommandCandidates(
      this.command,
      ["-p", "--output-format", "json", "--model", request.model],
      request.prompt,
      { cwd: request.cwd }
    );
    if (!result.ok && isCommandInvocationError(`${result.error || ""} ${result.stderr || ""}`)) {
      result = await runWithShellCandidates(
        this.command,
        ["-p", "--output-format", "json", "--model", request.model],
        request.prompt,
        { cwd: request.cwd }
      );
    }
    if (!result.ok && /unknown option|Unknown option|invalid option/i.test(result.stderr)) {
      result = await runWithCommandCandidates(this.command, ["-p", "--output-format", "json"], request.prompt, {
        cwd: request.cwd
      });
      if (!result.ok && isCommandInvocationError(`${result.error || ""} ${result.stderr || ""}`)) {
        result = await runWithShellCandidates(this.command, ["-p", "--output-format", "json"], request.prompt, {
          cwd: request.cwd
        });
      }
    }

    if (!result.ok) {
      const reason = (result.error || result.stderr || `exit code ${result.code}`).slice(0, 400);
      return `[orchestra] Claude CLI failed (${reason}). Ensure \`${this.command}\` is installed and authenticated.`;
    }
    const parsed = this.parseJsonOutput(result.stdout);
    return parsed || "[orchestra] Claude CLI returned no assistant text.";
  }
}

export function createProviderRegistry(providerConfig: OrchestraConfig["providers"]): ProviderRegistry {
  const codexApi = new OpenAIResponsesAdapter({
    providerName: "codex_api",
    baseUrl: providerConfig.codexApi?.baseUrl ?? "https://api.openai.com/v1",
    apiKey:
      providerConfig.codexApi?.apiKey ||
      providerConfig.openai?.apiKey ||
      providerConfig.openaiCompatible?.apiKey,
    defaultModel: providerConfig.codexApi?.defaultModel ?? "gpt-5.3-codex",
    headers: providerConfig.codexApi?.headers,
    enabled: providerConfig.codexApi?.enabled !== false
  });
  const codexSubscriptionApi = new CodexSubscriptionApiAdapter({
    providerName: "codex_subscription_api",
    baseUrl: providerConfig.codexSubscription?.apiBaseUrl ?? "https://chatgpt.com/backend-api/codex",
    defaultModel: providerConfig.codexApi?.defaultModel ?? "gpt-5.3-codex",
    enabled: providerConfig.codexSubscription?.enabled !== false
  });

  const openaiCompatible = new OpenAICompatibleAdapter({
    providerName: "openai_compatible",
    baseUrl: providerConfig.openaiCompatible?.baseUrl ?? "https://api.openai.com/v1",
    apiKey: providerConfig.openaiCompatible?.apiKey || providerConfig.openai?.apiKey,
    defaultModel: providerConfig.openaiCompatible?.defaultModel,
    headers: providerConfig.openaiCompatible?.headers
  });

  const openrouter = new OpenAICompatibleAdapter({
    providerName: "openrouter",
    baseUrl: providerConfig.openrouter?.baseUrl ?? "https://openrouter.ai/api/v1",
    apiKey: providerConfig.openrouter?.apiKey,
    defaultModel: providerConfig.openrouter?.defaultModel,
    headers: {
      ...(providerConfig.openrouter?.referer
        ? { "HTTP-Referer": providerConfig.openrouter.referer }
        : {}),
      ...(providerConfig.openrouter?.title ? { "X-Title": providerConfig.openrouter.title } : {})
    }
  });

  const nim = new OpenAICompatibleAdapter({
    providerName: "nim",
    baseUrl: providerConfig.nim?.baseUrl ?? "https://integrate.api.nvidia.com/v1",
    apiKey: providerConfig.nim?.apiKey,
    defaultModel: providerConfig.nim?.defaultModel
  });

  const codexTransport = (providerConfig.codexSubscription?.transport ?? "cli").toLowerCase();
  const codexSubscriptionCli = new CodexSubscriptionAdapter(
    providerConfig.codexSubscription?.command || "codex",
    providerConfig.codexSubscription?.enabled !== false
  );
  const codexSubscription =
    codexTransport === "api" ? codexSubscriptionApi : codexSubscriptionCli;

  const claudeSubscription = new ClaudeSubscriptionAdapter(
    providerConfig.claudeSubscription?.command || "claude",
    providerConfig.claudeSubscription?.enabled !== false
  );

  const adapters: Record<string, ModelAdapter> = {
    mock: new MockAdapter(),
    local: new MockAdapter(),
    codex_api: codexApi,
    codex_api_openai: codexApi,
    openai_responses: codexApi,
    codex_subscription_api: codexSubscriptionApi,
    openai_compatible: openaiCompatible,
    openrouter,
    nim,
    codex_subscription: codexSubscription,
    claude_subscription: claudeSubscription,
    openai: new OpenAICompatibleAdapter({
      providerName: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: providerConfig.openai?.apiKey || providerConfig.openaiCompatible?.apiKey
    }),
    anthropic: claudeSubscription,
    google: new MockAdapter()
  };

  return {
    getAdapter(provider: string): ModelAdapter {
      return adapters[provider] ?? adapters.mock;
    }
  };
}
