
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import blessed from "neo-blessed";
import { stringify as yamlStringify } from "yaml";
import { addRecentRepo, readConfig, writeConfig } from "./config";
import { addMemoryItem, listMemoryByScope, searchMemory } from "./memory";
import { EXAMPLE_WORKFLOW_YAML, OrchestraPaths } from "./paths";
import { executeRun } from "./runner";
import { listArtifacts, listRuns, readRunEvents, readRunMeta } from "./run-store";
import {
  MemoryScope,
  PlanReviewRequest,
  PlanReviewResponse,
  OrchestraConfig,
  RunEvent,
  WorkflowDefinition,
  WorkflowGateConfig,
  WorkflowStep,
  WorkflowToolCall
} from "./types";
import { listWorkflowFiles, loadWorkflowFromFile, parseWorkflowYaml, readWorkflowText, writeWorkflowText } from "./workflow";
import {
  BUILTIN_WORKFLOW_AUDIENCE_LABELS,
  BUILTIN_WORKFLOW_CATEGORY_LABELS,
  BuiltinWorkflowAudience,
  classifyBuiltinWorkflowTemplate,
  inferBuiltinWorkflowAudience,
  listBuiltinWorkflowTemplates
} from "./workflow-catalog";

interface AppDeps {
  paths: OrchestraPaths;
  config: OrchestraConfig;
}

type Nullable<T> = T | null;

const MENU_WIDTH = 28;
const MENU_HEIGHT = 10;
const TRACE_WIDTH = 38;
const WORKSPACE_WIDE_WIDTH = `100%-${MENU_WIDTH}`;
const WORKSPACE_NARROW_WIDTH = `100%-${MENU_WIDTH + TRACE_WIDTH}`;
const FULL_PANEL_HEIGHT = "100%-2";
const LOG_TOP = MENU_HEIGHT + 2;
const LOG_HEIGHT = `100%-${LOG_TOP}`;
const TRACE_EMPTY_STATE =
  "Trace is idle.\n\nEvents from model calls, tools, approvals, and diffs will appear here during runs.";

export function formatWorkspaceStepText(text: string): { body: string; footer: string } {
  let inDiff = false;
  let inTool = false;
  let pendingReplanHeading = false;
  let sawStepDone = false;
  let sawRestartWorkflow = false;
  const normalized = text.replace(/\u001b\[[0-9;]*m/g, "").replace(/\r\n/g, "\n").replace(/\t/g, "  ").trimEnd();
  const rawLines = normalized ? normalized.split("\n") : [""];

  const formattedLines = rawLines.flatMap((line) => {
    const trimmed = line.trim();
    const withoutContinue = trimmed.replace(/^\[CONTINUE\]\s*/i, "");
    if (withoutContinue.startsWith("Summary:")) {
      return [`\x1b[1;33m${withoutContinue}\x1b[0m`];
    }
    if (/^```orchestra_tool\b/i.test(trimmed)) {
      inTool = true;
      inDiff = false;
      return ["", "\x1b[1;35mTool request\x1b[0m"];
    }
    if (/^```diff\b/i.test(trimmed)) {
      inDiff = true;
      inTool = false;
      return ["", "\x1b[1;36mDiff\x1b[0m"];
    }
    if (/^REPLAN_MESSAGE\s*:/i.test(trimmed)) {
      pendingReplanHeading = true;
      const message = trimmed.replace(/^REPLAN_MESSAGE\s*:\s*/i, "").trim();
      return ["", "\x1b[1;31mReview handoff\x1b[0m", ...(message ? [`\x1b[37m${message}\x1b[0m`] : [])];
    }
    if (pendingReplanHeading) {
      if (trimmed === "[RESTART_WORKFLOW]") {
        pendingReplanHeading = false;
        return ["", "\x1b[1;31m[RESTART_WORKFLOW]\x1b[0m"];
      }
      if (trimmed.length > 0) {
        return [`\x1b[37m${trimmed}\x1b[0m`];
      }
      return [""];
    }
    if (trimmed === "```" && (inTool || inDiff)) {
      inTool = false;
      inDiff = false;
      return [""];
    }

    if (inTool) {
      return [trimmed ? `\x1b[35m${line}\x1b[0m` : ""];
    }
    if (inDiff) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        return [`\x1b[1;32m${line}\x1b[0m`];
      }
      if (line.startsWith("-") && !line.startsWith("---")) {
        return [`\x1b[1;31m${line}\x1b[0m`];
      }
      if (line.startsWith("diff --git")) {
        return ["", "", `\x1b[1;36m${line}\x1b[0m`];
      }
      if (line.startsWith("index ")) {
        return [`\x1b[90m${line}\x1b[0m`];
      }
      if (line.startsWith("---") || line.startsWith("+++")) {
        return [`\x1b[1;34m${line}\x1b[0m`];
      }
      if (line.startsWith("@@")) {
        return [`\x1b[1;36m${line}\x1b[0m`];
      }
      if (line.startsWith("\\")) {
        return [`\x1b[90m${line}\x1b[0m`];
      }
      return [`\x1b[37m${line}\x1b[0m`];
    }
    if (trimmed === "[STEP_DONE]") {
      sawStepDone = true;
      return [];
    }
    if (trimmed === "[RESTART_WORKFLOW]") {
      sawRestartWorkflow = true;
      return [];
    }
    if (trimmed === "[CONTINUE]") {
      return [];
    }
    return [line.replace(/\[CONTINUE\]/gi, "").trimEnd()];
  });

  while (formattedLines.length > 0 && formattedLines[formattedLines.length - 1]?.trim() === "") {
    formattedLines.pop();
  }
  if (sawStepDone) {
    formattedLines.push("", "\x1b[1;32m[STEP_DONE]\x1b[0m");
  } else if (sawRestartWorkflow) {
    formattedLines.push("", "\x1b[1;31m[RESTART_WORKFLOW]\x1b[0m");
  }
  const signal = formattedLines[formattedLines.length - 1]?.trim() ?? "";
  const footer =
    signal.includes("[STEP_DONE]")
      ? "Step complete"
      : signal.includes("[RESTART_WORKFLOW]")
        ? "Restarting workflow"
        : "Last update";
  const bodyLines =
    signal.includes("[STEP_DONE]") || signal.includes("[RESTART_WORKFLOW]") ? formattedLines.slice(0, -1) : formattedLines;
  const body = bodyLines
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { body: body || "(no output)", footer };
}

function formatWorkspaceToolRequestLine(request: Record<string, unknown>): string {
  const out: Record<string, string> = {};
  const tool = String(request.tool ?? "").trim() || "tool";
  const command = String(request.command ?? "").trim();
  const reqPath = String(request.path ?? "").trim();
  const cwd = String(request.cwd ?? "").trim();
  out.tool = tool;
  if (reqPath) {
    out.path = reqPath;
  }
  if (command) {
    out.command = command;
  }
  if (cwd) {
    out.cwd = cwd;
  }
  return JSON.stringify(out);
}

function readClipboardText(): string {
  try {
    return execFileSync("powershell", ["-NoProfile", "-Command", "Get-Clipboard -Raw"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).replace(/\r\n/g, "\n");
  } catch {
    return "";
  }
}

function sanitizeEditorInput(input: string): string {
  return input
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\]([^\u0007]|\u0007)*\u0007/g, "")
    .replace(/\u001bP[\s\S]*?\u001b\\/g, "")
    .replace(/\x1b\[200~/g, "")
    .replace(/\x1b\[201~/g, "")
    .replace(/[^\x09\x0a\x0d\x20-\x7e]/g, "");
}

function stripOrchestraToolBlocks(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];
  let inToolBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^```orchestra_tool\b/i.test(trimmed)) {
      inToolBlock = true;
      continue;
    }
    if (inToolBlock && trimmed === "```") {
      inToolBlock = false;
      continue;
    }
    if (!inToolBlock) {
      kept.push(line);
    }
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export class OrchestraTuiApp {
  private static readonly AI_SPINNER_FRAMES = ["◐", "◓", "◑", "◒"];
  private readonly screen: blessed.Widgets.Screen;
  private readonly statusBar: blessed.Widgets.BoxElement;
  private readonly menuList: blessed.Widgets.ListElement;
  private readonly mainBox: blessed.Widgets.BoxElement;
  private readonly workspaceActivityBox: blessed.Widgets.BoxElement;
  private readonly traceBox: blessed.Widgets.BoxElement;
  private readonly logBox: blessed.Widgets.Log;
  private config: OrchestraConfig;
  private busy = false;
  private workspaceSections: string[] = [];
  private lastWorkspaceSection = "";
  private workspaceAutoFollow = true;
  private traceAutoFollow = true;
  private traceFullJson = false;
  private traceVisible = false;
  private logVisible = false;
  private inputMode = false;
  private currentTraceEvents: RunEvent[] = [];
  private runActive = false;
  private terminateRequested = false;
  private queuedRunPrompts: string[] = [];
  private runPromptCaptureActive = false;
  private aiActivityCount = 0;
  private aiSpinnerFrame = 0;
  private aiSpinnerTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: AppDeps) {
    this.config = deps.config;
    this.screen = blessed.screen({
      smartCSR: true,
      fullUnicode: true,
      mouse: true,
      title: "Orchestra"
    });

    this.statusBar = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: "100%",
      height: 2,
      content: "",
      tags: true,
      style: { fg: "black", bg: "cyan" }
    });

    this.menuList = blessed.list({
      parent: this.screen,
      top: 2,
      left: 0,
      width: MENU_WIDTH,
      height: MENU_HEIGHT,
      border: "line",
      label: " Menu ",
      keys: true,
      mouse: true,
      vi: false,
      padding: {
        left: 1,
        right: 1
      },
      scrollbar: {
        ch: " ",
        track: { bg: "gray" },
        style: { bg: "blue" }
      },
      style: {
        border: {
          fg: "cyan"
        },
        item: {
          fg: "white"
        },
        selected: {
          fg: "black",
          bg: "green"
        }
      },
      items: ["Start New Run", "Edit Workflow", "Manage Memory", "View Runs", "Settings", "Quit"]
    });

    this.mainBox = blessed.box({
      parent: this.screen,
      top: 2,
      left: MENU_WIDTH,
      width: WORKSPACE_NARROW_WIDTH,
      height: FULL_PANEL_HEIGHT,
      border: "line",
      label: " Workspace ",
      keys: true,
      mouse: true,
      scrollable: true,
      alwaysScroll: true,
      tags: false,
      padding: {
        left: 1,
        right: 1,
        bottom: 1
      },
      scrollbar: {
        ch: " ",
        track: { bg: "gray" },
        style: { bg: "green" }
      },
      style: {
        border: {
          fg: "green"
        }
      },
      content: "Orchestra ready.\n\nChoose an action from the menu."
    });

    this.workspaceActivityBox = blessed.box({
      parent: this.mainBox,
      bottom: 0,
      left: 0,
      width: "100%-1",
      height: 1,
      tags: false,
      mouse: false,
      content: "",
      style: { fg: "yellow", bg: "black" }
    });

    this.traceBox = blessed.box({
      parent: this.screen,
      top: 2,
      left: `100%-${TRACE_WIDTH}`,
      width: TRACE_WIDTH,
      height: FULL_PANEL_HEIGHT,
      border: "line",
      label: " Trace ",
      keys: true,
      mouse: true,
      scrollable: true,
      alwaysScroll: true,
      tags: false,
      padding: {
        left: 1,
        right: 1
      },
      scrollbar: {
        ch: " ",
        track: { bg: "gray" },
        style: { bg: "magenta" }
      },
      style: {
        border: {
          fg: "magenta"
        }
      },
      content: TRACE_EMPTY_STATE
    });

    this.logBox = blessed.log({
      parent: this.screen,
      top: LOG_TOP,
      left: 0,
      width: MENU_WIDTH,
      height: LOG_HEIGHT,
      border: "line",
      label: " Log ",
      tags: false,
      keys: true,
      mouse: true,
      scrollback: 2000,
      padding: {
        left: 1,
        right: 1
      },
      scrollbar: {
        ch: " ",
        track: { bg: "gray" },
        style: { bg: "yellow" }
      },
      style: {
        border: {
          fg: "yellow"
        }
      }
    });

    this.bindWorkspaceScrollKeys();
    this.bindMouseSupport();
    this.applyPanelLayout();
    this.enableTerminalMouse();

    this.menuList.on("select", (_item, idx) => {
      void this.onMenuSelect(idx);
    });
    this.screen.key(["q", "C-q", "C-c"], () => this.shutdown());
    this.screen.key(["tab"], () => {
      const order = [this.menuList, this.mainBox] as blessed.Widgets.BlessedElement[];
      if (this.traceVisible) {
        order.push(this.traceBox);
      }
      if (this.logVisible) {
        order.push(this.logBox);
      }
      const idx = Math.max(0, order.indexOf(this.screen.focused as blessed.Widgets.BlessedElement));
      (order[(idx + 1) % order.length] as blessed.Widgets.BlessedElement).focus();
      this.updateStatusBar();
      this.screen.render();
    });
    this.screen.key(["S-tab"], () => {
      const order = [this.menuList, this.mainBox] as blessed.Widgets.BlessedElement[];
      if (this.traceVisible) {
        order.push(this.traceBox);
      }
      if (this.logVisible) {
        order.push(this.logBox);
      }
      const idx = Math.max(0, order.indexOf(this.screen.focused as blessed.Widgets.BlessedElement));
      (order[(idx - 1 + order.length) % order.length] as blessed.Widgets.BlessedElement).focus();
      this.updateStatusBar();
      this.screen.render();
    });
    this.traceBox.key(["j"], () => {
      if (this.inputMode || this.screen.focused !== this.traceBox) {
        return;
      }
      this.traceFullJson = !this.traceFullJson;
      this.refreshTraceLabel();
      this.renderTraceFromEvents();
      this.updateStatusBar();
    });
    this.screen.key(["C-p"], () => {
      if (!this.runActive || this.inputMode || this.runPromptCaptureActive) {
        return;
      }
      void this.captureRunPrompt();
    });
    this.screen.key(["C-x"], () => {
      if (!this.runActive || this.inputMode) {
        return;
      }
      if (!this.terminateRequested) {
        this.terminateRequested = true;
        this.log("[run-control] Termination requested. Orchestra will stop at the next safe checkpoint.");
        this.updateStatusBar();
        this.screen.render();
      }
    });

    const focusables = [this.menuList, this.mainBox, this.traceBox, this.logBox] as blessed.Widgets.BlessedElement[];
    for (const el of focusables) {
      el.on("focus", () => {
        this.updateStatusBar();
        this.screen.render();
      });
    }
    this.screen.on("resize", () => {
      this.applyPanelLayout();
      this.screen.render();
    });
  }

  start(): void {
    this.enableTerminalMouse();
    this.clearTrace();
    this.setTraceVisible(this.traceVisible);
    this.setLogVisible(this.logVisible);
    this.menuList.focus();
    this.updateStatusBar();
    this.screen.render();
  }

  private focusedPanelName(): "Menu" | "Workspace" | "Tool Trace" | "Log" | "Input" | "Other" {
    if (this.inputMode) {
      return "Input";
    }
    if (this.screen.focused === this.menuList) {
      return "Menu";
    }
    if (this.screen.focused === this.mainBox) {
      return "Workspace";
    }
    if (this.screen.focused === this.traceBox) {
      return "Tool Trace";
    }
    if (this.screen.focused === this.logBox) {
      return "Log";
    }
    return "Other";
  }

  private applyPanelLayout(): void {
    this.menuList.width = MENU_WIDTH;
    this.menuList.height = this.logVisible ? MENU_HEIGHT : FULL_PANEL_HEIGHT;
    this.mainBox.left = MENU_WIDTH;
    this.mainBox.height = FULL_PANEL_HEIGHT;
    this.traceBox.left = `100%-${TRACE_WIDTH}`;
    this.traceBox.width = TRACE_WIDTH;
    this.traceBox.height = FULL_PANEL_HEIGHT;
    this.logBox.top = LOG_TOP;
    this.logBox.left = 0;
    this.logBox.width = MENU_WIDTH;
    this.logBox.height = LOG_HEIGHT;
    this.mainBox.width = this.traceVisible ? WORKSPACE_NARROW_WIDTH : WORKSPACE_WIDE_WIDTH;
    this.workspaceActivityBox.width = "100%-1";
  }

  private bindMouseSupport(): void {
    const bindFocus = (el: blessed.Widgets.BlessedElement): void => {
      el.on("click", () => {
        if (this.inputMode) {
          return;
        }
        el.focus();
        this.updateStatusBar();
        this.screen.render();
      });
    };

    const installSingleStepWheel = (
      el: blessed.Widgets.BoxElement | blessed.Widgets.Log,
      onBeforeScroll?: () => void
    ): void => {
      el.removeAllListeners("wheelup");
      el.removeAllListeners("wheeldown");
      el.removeAllListeners("element wheelup");
      el.removeAllListeners("element wheeldown");
      el.on("wheelup", () => {
        if (this.inputMode) {
          return;
        }
        onBeforeScroll?.();
        el.scroll(-1);
        this.screen.render();
      });
      el.on("wheeldown", () => {
        if (this.inputMode) {
          return;
        }
        onBeforeScroll?.();
        el.scroll(1);
        this.screen.render();
      });
    };

    const getViewportHeight = (el: blessed.Widgets.BoxElement | blessed.Widgets.Log): number => {
      const anyEl = el as blessed.Widgets.BoxElement & { iheight?: number; height?: number };
      const rawHeight = typeof anyEl.height === "number" ? anyEl.height : 0;
      const innerHeight = typeof anyEl.iheight === "number" ? anyEl.iheight : 0;
      return Math.max(1, rawHeight - innerHeight);
    };

    const hasVerticalOverflow = (el: blessed.Widgets.BoxElement | blessed.Widgets.Log): boolean => {
      const anyEl = el as blessed.Widgets.BoxElement & { getScrollHeight?: () => number };
      const scrollHeight = anyEl.getScrollHeight?.() ?? 0;
      return scrollHeight > getViewportHeight(el);
    };

    const getMaxScroll = (el: blessed.Widgets.BoxElement | blessed.Widgets.Log): number => {
      const anyEl = el as blessed.Widgets.BoxElement & { getScrollHeight?: () => number };
      const scrollHeight = anyEl.getScrollHeight?.() ?? 0;
      return Math.max(0, scrollHeight - getViewportHeight(el));
    };

    const installStableScrollbar = (
      el: blessed.Widgets.BoxElement | blessed.Widgets.Log,
      onBeforeScroll?: () => void
    ): void => {
      const anyEl = el as blessed.Widgets.BoxElement & {
        _scrollingBar?: boolean;
        getScrollHeight?: () => number;
        getScroll?: () => number;
        scrollTo?: (offset: number, always?: boolean) => void;
        iheight?: number;
        iright?: number;
        aleft?: number;
        atop?: number;
        width?: number;
      };
      el.removeAllListeners("mousedown");
      let dragging = false;

      const setFromPointer = (data: { y: number }): void => {
        const coords = (el as unknown as { _getCoords: () => blessed.Widgets.Coords | undefined })._getCoords();
        if (!coords || !anyEl.scrollTo) {
          return;
        }
        const trackHeight = Math.max(1, coords.yl - coords.yi - 2);
        const maxScroll = getMaxScroll(el);
        if (maxScroll <= 0) {
          anyEl.scrollTo(0);
          this.screen.render();
          return;
        }
        const localY = Math.max(0, Math.min(trackHeight - 1, data.y - coords.yi - 1));
        const ratio = trackHeight <= 1 ? 0 : localY / (trackHeight - 1);
        let target = Math.round(ratio * maxScroll);
        if (localY <= 0 || target <= 1) {
          target = 0;
        } else if (localY >= trackHeight - 1 || target >= maxScroll - 1) {
          target = maxScroll;
        }
        const currentScroll = anyEl.getScroll?.() ?? 0;
        if (currentScroll === target) {
          return;
        }
        onBeforeScroll?.();
        anyEl.scrollTo(target);
        this.screen.render();
      };

      const onScreenMouse = (data: { action?: string; x: number; y: number }): void => {
        if (!dragging) {
          return;
        }
        if (data.action === "mouseup") {
          dragging = false;
          anyEl._scrollingBar = false;
          this.screen.removeListener("mouse", onScreenMouse);
          return;
        }
        if (data.action === "mousemove" || data.action === "mousedown") {
          setFromPointer(data);
        }
      };

      el.on("mousedown", (data: { x: number; y: number }) => {
        const coords = (el as unknown as { _getCoords: () => blessed.Widgets.Coords | undefined })._getCoords();
        if (!coords) {
          return;
        }
        const scrollbarX = coords.xl - 2;
        const insideScrollbar = data.x === scrollbarX && data.y >= coords.yi + 1 && data.y < coords.yl - 1;
        if (!insideScrollbar) {
          return;
        }
        if (!hasVerticalOverflow(el)) {
          dragging = false;
          anyEl._scrollingBar = false;
          return;
        }
        dragging = true;
        anyEl._scrollingBar = true;
        setFromPointer(data);
        this.screen.on("mouse", onScreenMouse);
      });
    };

    const bindWheelScroll = (el: blessed.Widgets.BoxElement | blessed.Widgets.Log, opts?: { autoFollow?: "workspace" | "trace" }) => {
      installSingleStepWheel(el, () => {
        if (opts?.autoFollow === "workspace") {
          this.workspaceAutoFollow = false;
        } else if (opts?.autoFollow === "trace") {
          this.traceAutoFollow = false;
        }
      });
      installStableScrollbar(el, () => {
        if (opts?.autoFollow === "workspace") {
          this.workspaceAutoFollow = false;
        } else if (opts?.autoFollow === "trace") {
          this.traceAutoFollow = false;
        }
      });
    };

    bindFocus(this.menuList);
    bindFocus(this.mainBox);
    bindFocus(this.traceBox);
    bindFocus(this.logBox);

    this.menuList.removeAllListeners("wheelup");
    this.menuList.removeAllListeners("wheeldown");
    this.menuList.removeAllListeners("element wheelup");
    this.menuList.removeAllListeners("element wheeldown");
    this.menuList.on("wheelup", () => {
      if (this.inputMode) {
        return;
      }
      const menuState = this.menuList as blessed.Widgets.ListElement & { selected?: number; items?: unknown[] };
      const nextIndex = Math.max(0, (menuState.selected ?? 0) - 1);
      this.menuList.select(nextIndex);
      this.screen.render();
    });
    this.menuList.on("wheeldown", () => {
      if (this.inputMode) {
        return;
      }
      const menuState = this.menuList as blessed.Widgets.ListElement & { selected?: number; items?: unknown[] };
      const lastIndex = Math.max(0, (menuState.items?.length ?? 1) - 1);
      const nextIndex = Math.min(lastIndex, (menuState.selected ?? 0) + 1);
      this.menuList.select(nextIndex);
      this.screen.render();
    });

    bindWheelScroll(this.mainBox, { autoFollow: "workspace" });
    bindWheelScroll(this.traceBox, { autoFollow: "trace" });
    bindWheelScroll(this.logBox);
  }

  private enableTerminalMouse(): void {
    const program = this.screen.program as typeof this.screen.program & {
      enableMouse?: () => void;
      setMouse?: (options: Record<string, boolean>, enable?: boolean) => void;
      setMode?: (...args: string[]) => void;
    };
    program.enableMouse?.();
    program.setMouse?.(
      {
        vt200Mouse: true,
        utfMouse: true,
        sgrMouse: true,
        cellMotion: true,
        allMotion: true,
        sendFocus: true
      },
      true
    );
    program.setMode?.("?2004");
  }

  private disableTerminalMouse(): void {
    const program = this.screen.program as typeof this.screen.program & {
      disableMouse?: () => void;
      resetMode?: (...args: string[]) => void;
    };
    program.disableMouse?.();
    program.resetMode?.("?2004");
  }

  private updateStatusBar(): void {
    const focus = this.focusedPanelName();
    const traceJson = this.traceFullJson ? "ON" : "OFF";
    const tracePane = this.traceVisible ? "ON" : "OFF";
    const logPane = this.logVisible ? "ON" : "OFF";
    const runState = this.runActive ? "ACTIVE" : "IDLE";
    const queued = this.queuedRunPrompts.length;
    const term = this.terminateRequested ? "YES" : "NO";
    let fg = "black";
    let bg = "cyan";
    if (focus === "Menu") {
      fg = "white";
      bg = "blue";
    } else if (focus === "Workspace") {
      fg = "black";
      bg = "green";
    } else if (focus === "Tool Trace") {
      fg = "white";
      bg = "magenta";
    } else if (focus === "Log") {
      fg = "black";
      bg = "yellow";
    } else if (focus === "Input") {
      fg = "white";
      bg = "red";
    }
    this.statusBar.setContent(
      `{bold}Orchestra{/bold} · ${focus} | Run ${runState} | Queue ${queued} | Stop ${term} | Trace ${tracePane}/${traceJson} · Log ${logPane}\n` +
      ` {bold}q{/bold}/{bold}Ctrl+Q{/bold}/{bold}Ctrl+C{/bold} quit | {bold}Tab{/bold}/{bold}S-Tab{/bold} panels | {bold}↑↓{/bold} scroll {bold}PgUp/PgDn{/bold} page {bold}Home/End{/bold} ends | {bold}f{/bold} follow | {bold}j{/bold} trace JSON | {bold}Ctrl+P{/bold} prompt | {bold}Ctrl+X{/bold} stop | {bold}Enter{/bold} select `
    );
    this.statusBar.style.fg = fg;
    this.statusBar.style.bg = bg;
  }

  private setTraceVisible(visible: boolean): void {
    this.traceVisible = visible;
    if (visible) {
      this.traceBox.show();
      this.renderTraceFromEvents();
    } else {
      if (this.screen.focused === this.traceBox) {
        this.mainBox.focus();
      }
      this.traceBox.hide();
    }
    this.applyPanelLayout();
    this.updateStatusBar();
    this.screen.render();
  }

  private setLogVisible(visible: boolean): void {
    this.logVisible = visible;
    if (visible) {
      this.logBox.show();
    } else {
      if (this.screen.focused === this.logBox) {
        this.mainBox.focus();
      }
      this.logBox.hide();
    }
    this.applyPanelLayout();
    this.updateStatusBar();
    this.screen.render();
  }

  private bindWorkspaceScrollKeys(): void {
    const focusedPane = (): "main" | "trace" | null => {
      if (this.inputMode) {
        return null;
      }
      if (this.screen.focused === this.mainBox) {
        return "main";
      }
      if (this.screen.focused === this.traceBox) {
        return "trace";
      }
      return null;
    };
    const activeBox = (): blessed.Widgets.BoxElement | null => {
      const pane = focusedPane();
      if (pane === "main") {
        return this.mainBox;
      }
      if (pane === "trace") {
        return this.traceBox;
      }
      return null;
    };
    const stopFollow = (): void => {
      const pane = focusedPane();
      if (pane === "main") {
        this.workspaceAutoFollow = false;
      } else if (pane === "trace") {
        this.traceAutoFollow = false;
      }
    };
    const onUp = (): void => {
      const box = activeBox();
      if (!box) return;
      stopFollow();
      box.scroll(-1);
      box.focus();
      this.screen.render();
    };
    const onDown = (): void => {
      const box = activeBox();
      if (!box) return;
      stopFollow();
      box.scroll(1);
      box.focus();
      this.screen.render();
    };
    const onPgUp = (): void => {
      const box = activeBox();
      if (!box) return;
      stopFollow();
      box.scroll(-12);
      box.focus();
      this.screen.render();
    };
    const onPgDown = (): void => {
      const box = activeBox();
      if (!box) return;
      stopFollow();
      box.scroll(12);
      box.focus();
      this.screen.render();
    };
    const onHome = (): void => {
      const box = activeBox();
      if (!box) return;
      stopFollow();
      box.setScroll(0);
      box.focus();
      this.screen.render();
    };
    const onEnd = (): void => {
      const box = activeBox();
      if (!box) return;
      stopFollow();
      box.setScrollPerc(100);
      box.focus();
      this.screen.render();
    };
    const onFollow = (): void => {
      const pane = focusedPane();
      const box = activeBox();
      if (!pane || !box) return;
      if (pane === "main") {
        this.workspaceAutoFollow = true;
      } else {
        this.traceAutoFollow = true;
      }
      box.setScrollPerc(100);
      box.focus();
      this.screen.render();
    };
    this.mainBox.key(["up"], onUp);
    this.mainBox.key(["down"], onDown);
    this.mainBox.key(["pageup"], onPgUp);
    this.mainBox.key(["pagedown"], onPgDown);
    this.mainBox.key(["home"], onHome);
    this.mainBox.key(["end"], onEnd);
    this.mainBox.key(["f"], onFollow);
    this.traceBox.key(["up"], onUp);
    this.traceBox.key(["down"], onDown);
    this.traceBox.key(["pageup"], onPgUp);
    this.traceBox.key(["pagedown"], onPgDown);
    this.traceBox.key(["home"], onHome);
    this.traceBox.key(["end"], onEnd);
    this.traceBox.key(["f"], onFollow);
    this.screen.key(["up"], onUp);
    this.screen.key(["down"], onDown);
    this.screen.key(["pageup"], onPgUp);
    this.screen.key(["pagedown"], onPgDown);
    this.screen.key(["home"], onHome);
    this.screen.key(["end"], onEnd);
    this.screen.key(["f"], onFollow);
  }

  private shutdown(): void {
    this.stopAiSpinner();
    this.disableTerminalMouse();
    this.screen.destroy();
    process.exit(0);
  }

  private async onMenuSelect(index: number): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    try {
      if (index === 0) {
        await this.startRunFlow();
      } else if (index === 1) {
        await this.editWorkflowFlow();
      } else if (index === 2) {
        await this.manageMemoryFlow();
      } else if (index === 3) {
        await this.viewRunsFlow();
      } else if (index === 4) {
        await this.settingsFlow();
      } else {
        this.shutdown();
      }
    } finally {
      this.busy = false;
      this.menuList.focus();
      this.screen.render();
    }
  }

  private beginRunSession(): void {
    this.runActive = true;
    this.terminateRequested = false;
    this.queuedRunPrompts = [];
    this.runPromptCaptureActive = false;
    this.lastWorkspaceSection = this.workspaceSections[this.workspaceSections.length - 1] ?? "";
    this.resetAiActivity();
    this.updateStatusBar();
    this.screen.render();
  }

  private endRunSession(): void {
    this.runActive = false;
    this.terminateRequested = false;
    this.queuedRunPrompts = [];
    this.runPromptCaptureActive = false;
    this.lastWorkspaceSection = "";
    this.resetAiActivity();
    this.updateStatusBar();
    this.screen.render();
  }

  private resetAiActivity(): void {
    this.aiActivityCount = 0;
    this.aiSpinnerFrame = 0;
    this.stopAiSpinner();
  }

  private startAiSpinner(): void {
    if (this.aiSpinnerTimer) {
      return;
    }
    this.aiSpinnerTimer = setInterval(() => {
      if (this.aiActivityCount <= 0) {
        return;
      }
      this.aiSpinnerFrame = (this.aiSpinnerFrame + 1) % OrchestraTuiApp.AI_SPINNER_FRAMES.length;
      this.renderWorkspaceActivity();
      this.updateStatusBar();
      this.screen.render();
    }, 120);
  }

  private stopAiSpinner(): void {
    if (!this.aiSpinnerTimer) {
      return;
    }
    clearInterval(this.aiSpinnerTimer);
    this.aiSpinnerTimer = null;
  }

  private noteAiActivityStart(): void {
    this.aiActivityCount += 1;
    this.startAiSpinner();
    this.renderWorkspaceActivity();
    this.updateStatusBar();
    this.screen.render();
  }

  private noteAiActivityEnd(): void {
    this.aiActivityCount = Math.max(0, this.aiActivityCount - 1);
    if (this.aiActivityCount === 0) {
      this.aiSpinnerFrame = 0;
      this.stopAiSpinner();
    }
    this.renderWorkspaceActivity();
    this.updateStatusBar();
    this.screen.render();
  }

  private consumeQueuedRunPrompts(): string[] {
    if (this.queuedRunPrompts.length === 0) {
      return [];
    }
    const out = [...this.queuedRunPrompts];
    this.queuedRunPrompts = [];
    this.updateStatusBar();
    this.screen.render();
    return out;
  }

  private async captureRunPrompt(): Promise<void> {
    this.runPromptCaptureActive = true;
    this.updateStatusBar();
    this.screen.render();
    try {
      const text = await this.promptInput("Add instruction for next iteration", "");
      if (!text || !text.trim()) {
        return;
      }
      this.queuedRunPrompts.push(text.trim());
      this.log(`[run-control] Queued prompt for next iteration (${text.trim().length} chars).`);
      this.appendMain(
        `${this.renderWorkspaceBlock("Queued instruction", [text.trim()], "Will be injected on the next iteration")}\n`
      );
      this.updateStatusBar();
      this.screen.render();
    } finally {
      this.runPromptCaptureActive = false;
      this.updateStatusBar();
      this.screen.render();
    }
  }

  private cleanPanelText(text: string): string {
    return text.replace(/\u001b\[[0-9;]*m/g, "").replace(/\r\n/g, "\n").replace(/\t/g, "  ").trimEnd();
  }

  private renderWorkspaceBlock(title: string, lines: string[], footer?: string): string {
    const safeTitle = title.trim() || "Workspace";
    const cleanedLines = lines.flatMap((line) => line.replace(/\r\n/g, "\n").replace(/\t/g, "  ").trimEnd().split("\n"));
    const out = [`\x1b[1;36m${safeTitle}\x1b[0m`];
    out.push(...(cleanedLines.length > 0 ? cleanedLines : [""]));
    if (footer) {
      out.push(`\x1b[90m${footer}\x1b[0m`);
    }
    return out.join("\n");
  }

  private formatWorkspaceDocument(text: string): string {
    const normalized = text
      .replace(/\r\n/g, "\n")
      .replace(/\t/g, "  ")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd();
    return normalized.length > 0 ? normalized : " ";
  }

  private composeWorkspaceContent(): string {
    const joined = this.workspaceSections.join("\n\n");
    return joined.length > 500_000 ? joined.slice(joined.length - 400_000) : joined || " ";
  }

  private renderWorkspaceActivity(): void {
    const content =
      this.aiActivityCount > 0 ? ` AI working ${OrchestraTuiApp.AI_SPINNER_FRAMES[this.aiSpinnerFrame]} ` : "";
    this.workspaceActivityBox.setContent(content);
  }

  private renderWorkspaceSections(): void {
    const previousScroll = this.mainBox.getScroll();
    this.mainBox.setContent(this.composeWorkspaceContent());
    this.renderWorkspaceActivity();
    if (this.workspaceAutoFollow) {
      this.mainBox.setScrollPerc(100);
    } else {
      this.mainBox.setScroll(previousScroll);
    }
    this.screen.render();
  }

  private setMainContent(text: string): void {
    this.workspaceSections = [this.formatWorkspaceDocument(text)];
    this.lastWorkspaceSection = this.workspaceSections[0];
    this.mainBox.setContent(this.composeWorkspaceContent());
    this.renderWorkspaceActivity();
    this.mainBox.setScroll(0);
    this.screen.render();
  }

  private appendMain(text: string): void {
    const nextSection = this.formatWorkspaceDocument(text);
    if (nextSection === this.lastWorkspaceSection) {
      return;
    }
    this.workspaceSections.push(nextSection);
    if (this.workspaceSections.length > 120) {
      this.workspaceSections = this.workspaceSections.slice(this.workspaceSections.length - 90);
    }
    this.lastWorkspaceSection = nextSection;
    this.renderWorkspaceSections();
  }

  private appendStepOutput(stepId: string, text: string, iteration?: number): void {
    const label = stepId.trim() ? stepId : "step";
    const passLabel = iteration && Number.isFinite(iteration) ? iteration : 1;
    const title = `${label.toUpperCase()} - pass ${passLabel}`;
    const formatted = formatWorkspaceStepText(this.cleanPanelText(text));
    const footer = formatted.footer === "Last update" ? `Last update from ${label}` : formatted.footer;
    const withHeader = this.renderWorkspaceBlock(title, formatted.body.split("\n"), footer);
    this.appendMain(withHeader);
  }

  private renderWorkspaceCandidate(event: RunEvent): void {
    const modelOutput = typeof event.data.modelOutput === "string" ? event.data.modelOutput : "";
    const iteration = typeof event.data.iteration === "number" ? event.data.iteration : undefined;
    const toolRequestsRaw = Array.isArray(event.data.toolRequests) ? event.data.toolRequests : [];
    const toolRequests = toolRequestsRaw.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"));
    let renderedText = modelOutput;
    if (toolRequests.length > 0) {
      const fallbackToolBlock = ["```orchestra_tool", ...toolRequests.map((request) => formatWorkspaceToolRequestLine(request)), "```"].join("\n");
      const withoutRawToolBlocks = stripOrchestraToolBlocks(renderedText);
      renderedText = withoutRawToolBlocks
        ? `${withoutRawToolBlocks}\n\n${fallbackToolBlock}`
        : `Summary: Requested tool access.\n\n${fallbackToolBlock}`;
    }
    if (renderedText.trim()) {
      this.appendStepOutput(event.stepId ?? "step", renderedText, iteration);
    }
  }

  private log(line: string): void {
    this.logBox.log(line);
    this.screen.render();
  }

  private refreshTraceLabel(): void {
    this.traceBox.setLabel(` Trace · ${this.traceFullJson ? "full JSON" : "summary"} `);
  }

  private clearTrace(): void {
    this.currentTraceEvents = [];
    this.traceAutoFollow = true;
    this.refreshTraceLabel();
    this.traceBox.setContent(
      `${TRACE_EMPTY_STATE}\n\nLegend:\n[OK] success\n[ERR] failure\n[APPROVAL] gate\n[DIFF] patch activity\n\nPress j to toggle full JSON.`
    );
    this.traceBox.setScroll(0);
    this.screen.render();
  }

  private pushTraceLine(text: string): void {
    const prev = this.traceBox.getContent();
    const next = prev ? `${prev}\n${text}` : text;
    const capped = next.length > 450_000 ? next.slice(next.length - 320_000) : next;
    this.traceBox.setContent(capped);
    if (this.traceAutoFollow) {
      this.traceBox.setScrollPerc(100);
    }
    this.screen.render();
  }

  private renderTraceFromEvents(): void {
    this.refreshTraceLabel();
    if (this.currentTraceEvents.length === 0) {
      this.traceBox.setContent(
        `${TRACE_EMPTY_STATE}\n\nLegend:\n[OK] success\n[ERR] failure\n[APPROVAL] gate\n[DIFF] patch activity\n\nPress j to toggle full JSON.`
      );
      this.traceBox.setScroll(0);
      this.screen.render();
      return;
    }
    const lines: string[] = [];
    for (const event of this.currentTraceEvents) {
      const line = this.formatTraceEvent(event);
      if (line) {
        lines.push(line);
      }
    }
    const joined = lines.join("\n");
    const capped = joined.length > 450_000 ? joined.slice(joined.length - 320_000) : joined;
    this.traceBox.setContent(capped);
    if (this.traceAutoFollow) {
      this.traceBox.setScrollPerc(100);
    }
    this.screen.render();
  }

  private shortTs(iso: string): string {
    const time = iso.split("T")[1] ?? iso;
    return time.replace("Z", "");
  }

  private traceIcon(event: RunEvent): string {
    if (event.type === "tool_result") {
      return event.data.ok === false ? "[ERR]" : "[OK]";
    }
    if (event.type === "error" || event.type === "run_cancelled") {
      return "[ERR]";
    }
    if (event.type === "approval_requested" || event.type === "approval_result") {
      return "[APPROVAL]";
    }
    if (event.type === "diff_detected" || event.type === "diff_applied") {
      return "[DIFF]";
    }
    if (event.type === "candidate_generated" || event.type === "model_called") {
      return "[MODEL]";
    }
    if (event.type === "tool_called") {
      return "[TOOL]";
    }
    return "[INFO]";
  }

  private formatTraceEvent(event: RunEvent): string | null {
    const step = event.stepId ?? "-";
    const ts = this.shortTs(event.ts);
    const icon = this.traceIcon(event);
    if (this.traceFullJson) {
      const payload = JSON.stringify(event.data, null, 2);
      return [
        `${icon} ${ts} [${step}] ${event.type}`,
        payload,
        "------------------------"
      ].join("\n");
    }
    if (event.type === "tool_called") {
      const tool = String(event.data.tool ?? "");
      const command = String(event.data.command ?? "");
      const reqPath = String(event.data.path ?? "");
      const source = String(event.data.source ?? "");
      const details = command || reqPath || "";
      return `${icon} ${ts} [${step}] tool_called ${tool}${source ? ` source=${source}` : ""}${details ? ` | ${details}` : ""}`;
    }
    if (event.type === "tool_result") {
      const tool = String(event.data.tool ?? "");
      const ok = Boolean(event.data.ok);
      const cached = Boolean(event.data.cached);
      const source = String(event.data.source ?? "");
      const out = String(event.data.output ?? "").replace(/\s+/g, " ").trim();
      return `${icon} ${ts} [${step}] tool_result ${tool} ok=${ok}${cached ? " cached=true" : ""}${source ? ` source=${source}` : ""} | ${out.slice(0, 140)}`;
    }
    if (event.type === "approval_requested" || event.type === "approval_result") {
      return `${icon} ${ts} [${step}] ${event.type} ${JSON.stringify(event.data).slice(0, 180)}`;
    }
    if (event.type === "diff_detected" || event.type === "diff_applied") {
      return `${icon} ${ts} [${step}] ${event.type} ${JSON.stringify(event.data).slice(0, 180)}`;
    }
    if (event.type === "repo_summary_built") {
      const cached = Boolean(event.data.cached);
      const files = Number(event.data.filesScanned ?? 0);
      const bytes = Number(event.data.bytesRead ?? 0);
      return `${icon} ${ts} [${step}] repo_summary_built cached=${cached} files=${files} bytes=${bytes}`;
    }
    if (event.type === "memory_retrieved") {
      const cached = Boolean(event.data.cached);
      const count = Number(event.data.count ?? 0);
      return `${icon} ${ts} [${step}] memory_retrieved cached=${cached} count=${count}`;
    }
    if (event.type === "model_called" || event.type === "vote_completed") {
      return `${icon} ${ts} [${step}] ${event.type} ${JSON.stringify(event.data).slice(0, 180)}`;
    }
    if (event.type === "user_prompt_injected" || event.type === "run_cancelled") {
      return `${icon} ${ts} [${step}] ${event.type} ${JSON.stringify(event.data).slice(0, 220)}`;
    }
    if (event.type === "candidate_generated") {
      const summary = String(event.data.summary ?? event.data.preview ?? "").replace(/\s+/g, " ").trim();
      const toolRequestsRaw = Array.isArray(event.data.toolRequests) ? event.data.toolRequests : [];
      const toolRequests = toolRequestsRaw
        .map((req) => {
          if (!req || typeof req !== "object") {
            return "";
          }
          const record = req as Record<string, unknown>;
          const tool = String(record.tool ?? "");
          const command = String(record.command ?? "");
          const reqPath = String(record.path ?? "");
          const details = command || reqPath;
          return details ? `${tool}(${details})` : tool;
        })
        .filter(Boolean)
        .slice(0, 3);
      const providerCallsRaw = Array.isArray(event.data.providerToolCalls) ? event.data.providerToolCalls : [];
      const providerCalls = providerCallsRaw
        .map((entry) => {
          if (!entry || typeof entry !== "object") {
            return "";
          }
          const rec = entry as Record<string, unknown>;
          const tool = String(rec.tool ?? "");
          const command = String(rec.command ?? "");
          const source = String(rec.source ?? "");
          if (!tool && !command) {
            return "";
          }
          const label = tool || "tool";
          const detail = command ? `(${command.slice(0, 36)})` : "";
          const src = source ? `@${source}` : "";
          return `${label}${detail}${src}`;
        })
        .filter(Boolean)
        .slice(0, 3);
      const orchestraTools = toolRequests.length > 0 ? toolRequests.join(", ") : "-";
      const providerTools = providerCalls.length > 0 ? providerCalls.join(", ") : "-";
      const providerRawCount = Number(event.data.providerRawJsonEvents ?? 0);
      return `${icon} ${ts} [${step}] candidate_generated orchestra=[${orchestraTools}] provider=[${providerTools}] provider_json=${providerRawCount} | ${summary.slice(0, 160)}`;
    }
    return null;
  }

  private onRunEvent(event: RunEvent): void {
    const visibleTypes = new Set<RunEvent["type"]>([
      "repo_summary_built",
      "memory_retrieved",
      "model_called",
      "candidate_generated",
      "vote_completed",
      "tool_called",
      "tool_result",
      "user_prompt_injected",
      "run_cancelled",
      "diff_detected",
      "approval_requested",
      "approval_result",
      "diff_applied",
      "error"
    ]);
    if (!visibleTypes.has(event.type)) {
      return;
    }
    this.currentTraceEvents.push(event);
    if (this.currentTraceEvents.length > 1200) {
      this.currentTraceEvents = this.currentTraceEvents.slice(this.currentTraceEvents.length - 800);
    }
    if (event.type === "candidate_generated") {
      this.renderWorkspaceCandidate(event);
    }
    if (event.type === "model_called" || event.type === "tool_called") {
      this.noteAiActivityStart();
    } else if (event.type === "candidate_generated" || event.type === "tool_result" || event.type === "error") {
      this.noteAiActivityEnd();
    }
    const line = this.formatTraceEvent(event);
    if (line && this.traceVisible) {
      this.pushTraceLine(line);
    }
  }
  private async promptInput(title: string, initial = "", options?: { censor?: boolean }): Promise<Nullable<string>> {
    return new Promise((resolve) => {
      this.inputMode = true;
      this.updateStatusBar();
      const wrapper = blessed.box({
        parent: this.screen,
        border: "line",
        width: "78%",
        height: 9,
        top: "center",
        left: "center",
        label: ` ${title} `,
        keys: true,
        mouse: true
      });
      blessed.box({
        parent: wrapper,
        top: 0,
        left: 1,
        width: "100%-2",
        height: 1,
        content: " Enter submit | Esc cancel | Ctrl+Shift+V paste | Left/Right/Home/End supported ",
        style: { fg: "yellow" }
      });
      const field = blessed.box({
        parent: wrapper,
        top: 2,
        left: 1,
        width: "100%-4",
        height: 3,
        border: "line",
        tags: true,
        style: {
          fg: "white",
          bg: "black",
          border: { fg: "cyan" }
        }
      });

      let value = initial;
      let cursor = value.length;
      let hOffset = 0;
      let selectionAnchor: number | null = null;
      let selectionFocus: number | null = null;

      const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
      const isPrintable = (ch: string, key: { ctrl?: boolean; meta?: boolean }): boolean =>
        Boolean(ch) && !key.ctrl && !key.meta && /^[^\x00-\x1f\x7f]$/.test(ch);
      const selectionRange = (): { start: number; end: number } | null => {
        if (selectionAnchor === null || selectionFocus === null || selectionAnchor === selectionFocus) {
          return null;
        }
        return {
          start: Math.min(selectionAnchor, selectionFocus),
          end: Math.max(selectionAnchor, selectionFocus)
        };
      };
      const clearSelection = (): void => {
        selectionAnchor = null;
        selectionFocus = null;
      };
      const setCursor = (next: number, extendSelection = false): void => {
        const clamped = clamp(next, 0, value.length);
        if (extendSelection) {
          if (selectionAnchor === null) {
            selectionAnchor = cursor;
          }
          selectionFocus = clamped;
        } else {
          clearSelection();
        }
        cursor = clamped;
      };
      const replaceSelection = (insertText: string): boolean => {
        const range = selectionRange();
        if (!range) {
          return false;
        }
        value = `${value.slice(0, range.start)}${insertText}${value.slice(range.end)}`;
        cursor = range.start + insertText.length;
        clearSelection();
        return true;
      };
      const getInnerWidth = (): number => {
        const coords = (field as unknown as { _getCoords: () => blessed.Widgets.Coords | undefined })._getCoords();
        if (coords) {
          return Math.max(4, coords.xl - coords.xi - 1);
        }
        return 60;
      };
      const escapeTagText = (input: string): string => input.replace(/[{}]/g, "");
      const renderVisibleValue = (innerWidth: number): string => {
        const range = selectionRange();
        const raw = value.slice(hOffset, hOffset + innerWidth);
        const visibleRaw = options?.censor ? "*".repeat(raw.length) : raw;
        const chars = visibleRaw.split("");
        const visibleStart = hOffset;
        const visibleEnd = hOffset + innerWidth;
        if (range) {
          const start = Math.max(range.start, visibleStart);
          const end = Math.min(range.end, visibleEnd);
          for (let i = start; i < end; i += 1) {
            const idx = i - visibleStart;
            const ch = chars[idx] ?? " ";
            chars[idx] = `{inverse}${escapeTagText(ch)}{/inverse}`;
          }
        }
        const rendered = chars.map((ch) => (ch.includes("{") ? ch : escapeTagText(ch))).join("");
        const visibleLength = visibleRaw.length;
        return `${rendered}${" ".repeat(Math.max(0, innerWidth - visibleLength))}`;
      };
      const placeCursor = (): void => {
        const coords = (field as unknown as { _getCoords: () => blessed.Widgets.Coords | undefined })._getCoords();
        if (!coords) return;
        const x = coords.xi + 1 + clamp(cursor - hOffset, 0, getInnerWidth() - 1);
        const y = coords.yi + 1;
        this.screen.program.showCursor();
        this.screen.program.cup(y, x);
      };
      const redraw = (): void => {
        const innerWidth = getInnerWidth();
        if (cursor < hOffset) {
          hOffset = cursor;
        } else if (cursor > hOffset + innerWidth - 1) {
          hOffset = Math.max(0, cursor - innerWidth + 1);
        }
        field.setContent(renderVisibleValue(innerWidth));
        this.screen.render();
        placeCursor();
      };

      const cleanup = (): void => {
        this.screen.removeListener("keypress", onKey);
        this.inputMode = false;
        this.screen.program.hideCursor();
        wrapper.destroy();
        this.updateStatusBar();
        this.screen.render();
      };

      const finish = (result: string | null): void => {
        cleanup();
        resolve(result);
      };

      const pasteClipboard = (): void => {
        const clip = sanitizeEditorInput(readClipboardText());
        if (!clip) {
          return;
        }
        replaceSelection("");
        value = `${value.slice(0, cursor)}${clip}${value.slice(cursor)}`;
        cursor += clip.length;
        redraw();
      };

      const onKey = (ch: string, key: { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; full?: string }): void => {
        if (key.name === "escape") {
          finish(null);
          return;
        }
        if (key.name === "enter" || key.name === "return") {
          finish(value);
          return;
        }
        if (key.full === "C-S-v") {
          pasteClipboard();
          return;
        }
        if (key.name === "left") {
          setCursor(cursor - 1, Boolean(key.shift));
          redraw();
          return;
        }
        if (key.name === "right") {
          setCursor(cursor + 1, Boolean(key.shift));
          redraw();
          return;
        }
        if (key.name === "home") {
          setCursor(0, Boolean(key.shift));
          redraw();
          return;
        }
        if (key.name === "end") {
          setCursor(value.length, Boolean(key.shift));
          redraw();
          return;
        }
        if (key.name === "backspace") {
          if (replaceSelection("")) {
            redraw();
            return;
          }
          if (cursor > 0) {
            value = `${value.slice(0, cursor - 1)}${value.slice(cursor)}`;
            cursor -= 1;
            redraw();
          }
          return;
        }
        if (key.name === "delete") {
          if (replaceSelection("")) {
            redraw();
            return;
          }
          if (cursor < value.length) {
            value = `${value.slice(0, cursor)}${value.slice(cursor + 1)}`;
            redraw();
          }
          return;
        }
        if (isPrintable(ch, key)) {
          replaceSelection("");
          const inserted = sanitizeEditorInput(ch);
          if (!inserted) {
            redraw();
            return;
          }
          value = `${value.slice(0, cursor)}${inserted}${value.slice(cursor)}`;
          cursor += inserted.length;
          redraw();
        }
      };

      this.screen.on("keypress", onKey);
      wrapper.focus();
      redraw();
    });
  }

  private async askConfirm(title: string, message: string): Promise<boolean> {
    return new Promise((resolve) => {
      const screenWidth = Number(this.screen.width);
      const modalWidth = Math.max(64, Math.min(screenWidth - 12, 120));
      const wrapper = blessed.box({
        parent: this.screen,
        border: "line",
        width: modalWidth,
        height: 16,
        top: "center",
        left: "center",
        label: ` ${title} `,
        keys: true,
        mouse: true,
        vi: false,
        style: {
          border: { fg: "cyan" }
        }
      });

      const body = blessed.box({
        parent: wrapper,
        top: 1,
        left: 1,
        width: "100%-2",
        height: "100%-6",
        tags: false,
        scrollable: true,
        alwaysScroll: true,
        keys: true,
        mouse: true,
        vi: false,
        content: `${message}\n\nUse Left/Right, Enter, or click a button. Esc cancels.`
      });

      const actions = blessed.box({
        parent: wrapper,
        bottom: 1,
        left: 3,
        width: "100%-8",
        height: 5,
        mouse: true
      });

      const actionRow = blessed.box({
        parent: actions,
        top: 1,
        left: 0,
        width: "100%",
        height: 3,
        mouse: true
      });

      const continueButton = blessed.box({
        parent: actionRow,
        top: 0,
        left: 0,
        width: "50%-4",
        height: 3,
        border: "line",
        align: "center",
        valign: "middle",
        tags: false,
        mouse: true,
        content: "Continue"
      });

      const cancelButton = blessed.box({
        parent: actionRow,
        top: 0,
        right: 0,
        width: "50%-4",
        height: 3,
        border: "line",
        align: "center",
        valign: "middle",
        tags: false,
        mouse: true,
        content: "Cancel"
      });

      let selectedAction = 1;

      const setSelection = (next: number): void => {
        if (selectedAction === next) {
          return;
        }
        selectedAction = next;
        renderActions();
      };

      const renderActions = (): void => {
        const selectedStyle = { fg: "black", bg: "white", bold: true };
        const idleStyle = { fg: "white", bg: "black", bold: false };
        continueButton.style = selectedAction === 0 ? selectedStyle : idleStyle;
        cancelButton.style = selectedAction === 1 ? selectedStyle : idleStyle;
        continueButton.style.border = { fg: selectedAction === 0 ? "green" : "cyan" };
        cancelButton.style.border = { fg: selectedAction === 1 ? "green" : "cyan" };
        this.screen.render();
      };

      const finish = (ok: boolean): void => {
        wrapper.destroy();
        this.screen.render();
        resolve(ok);
      };

      const moveSelection = (delta: number): void => {
        const next = selectedAction + delta < 0 ? 1 : selectedAction + delta > 1 ? 0 : selectedAction + delta;
        setSelection(next);
      };

      const bindConfirmKeys = (target: blessed.Widgets.BoxElement): void => {
        target.key(["escape", "q"], () => finish(false));
        target.key(["left", "h"], () => moveSelection(-1));
        target.key(["right", "l"], () => moveSelection(1));
        target.key(["enter", "return"], () => finish(selectedAction === 0));
      };

      bindConfirmKeys(wrapper);
      bindConfirmKeys(body);
      bindConfirmKeys(actions);
      bindConfirmKeys(continueButton);
      bindConfirmKeys(cancelButton);

      continueButton.on("click", () => {
        setSelection(0);
        finish(true);
      });
      cancelButton.on("click", () => {
        setSelection(1);
        finish(false);
      });
      continueButton.on("mouseover", () => {
        setSelection(0);
      });
      cancelButton.on("mouseover", () => {
        setSelection(1);
      });

      wrapper.focus();
      renderActions();
      this.screen.render();
    });
  }

  private async showMessage(title: string, text: string): Promise<void> {
    await new Promise<void>((resolve) => {
      const msg = blessed.message({
        parent: this.screen,
        border: "line",
        width: "90%",
        height: "70%",
        top: "center",
        left: "center",
        label: ` ${title} `,
        keys: true,
        vi: false,
        scrollable: true
      });
      msg.display(text, 0, () => {
        msg.destroy();
        this.screen.render();
        resolve();
      });
      this.screen.render();
    });
  }

  private async pickOne(title: string, items: string[]): Promise<Nullable<string>> {
    return new Promise((resolve) => {
      const list = blessed.list({
        parent: this.screen,
        border: "line",
        width: "70%",
        height: "70%",
        top: "center",
        left: "center",
        label: ` ${title} `,
        keys: true,
        mouse: true,
        vi: false,
        style: {
          item: { fg: "white" },
          selected: { fg: "black", bg: "green", bold: true },
          border: { fg: "cyan" }
        },
        items
      });
      list.select(0);
      list.focus();
      list.on("select", (item) => {
        const value = item.getText();
        list.destroy();
        this.screen.render();
        resolve(value);
      });
      list.key(["escape", "q"], () => {
        list.destroy();
        this.screen.render();
        resolve(null);
      });
      this.screen.render();
    });
  }

  private async editMultiline(title: string, initial: string): Promise<Nullable<string>> {
    return new Promise((resolve) => {
      this.inputMode = true;
      this.updateStatusBar();
      const screenWidth = Number(this.screen.width);
      const modalWidth = Math.max(72, Math.min(screenWidth - 8, 140));
      const wrapper = blessed.box({
        parent: this.screen,
        border: "line",
        width: modalWidth,
        height: "90%",
        top: "center",
        left: "center",
        label: ` ${title} `,
        keys: true,
        mouse: true,
        style: {
          border: { fg: "cyan" }
        }
      });
      blessed.box({
        parent: wrapper,
        top: 0,
        left: 1,
        width: "100%-2",
        height: 1,
        content: " Ctrl+S save | Esc cancel | Ctrl+Shift+V paste | Arrows/Home/End/Page keys supported ",
        style: { fg: "yellow" }
      });
      const editor = blessed.box({
        parent: wrapper,
        top: 2,
        left: 1,
        width: "100%-4",
        height: "100%-4",
        border: "line",
        tags: true,
        keys: true,
        mouse: true,
        wrap: false,
        style: {
          fg: "white",
          bg: "black",
          border: { fg: "cyan" }
        }
      });

      let value = initial;
      let cursor = value.length;
      let rowOffset = 0;
      let colOffset = 0;
      let preferredCol: number | null = null;
      let selectionAnchor: number | null = null;
      let selectionFocus: number | null = null;

      const lineStarts = (src: string): number[] => {
        const lines = src.split("\n");
        const starts: number[] = [];
        let p = 0;
        for (const line of lines) {
          starts.push(p);
          p += line.length + 1;
        }
        return starts;
      };
      const indexToRowCol = (src: string, idx: number): { row: number; col: number } => {
        const starts = lineStarts(src);
        const lines = src.split("\n");
        const safe = Math.max(0, Math.min(idx, src.length));
        for (let row = 0; row < lines.length; row += 1) {
          const start = starts[row];
          const end = start + lines[row].length;
          if (safe <= end) {
            return { row, col: safe - start };
          }
        }
        const last = Math.max(0, lines.length - 1);
        return { row: last, col: lines[last]?.length ?? 0 };
      };
      const rowColToIndex = (src: string, row: number, col: number): number => {
        const lines = src.split("\n");
        const starts = lineStarts(src);
        const r = Math.max(0, Math.min(row, lines.length - 1));
        const c = Math.max(0, Math.min(col, lines[r].length));
        return starts[r] + c;
      };
      const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
      const isPrintable = (ch: string, key: { ctrl?: boolean; meta?: boolean }): boolean =>
        Boolean(ch) && !key.ctrl && !key.meta && /^[^\x00-\x1f\x7f]$/.test(ch);
      const selectionRange = (): { start: number; end: number } | null => {
        if (selectionAnchor === null || selectionFocus === null || selectionAnchor === selectionFocus) {
          return null;
        }
        return {
          start: Math.min(selectionAnchor, selectionFocus),
          end: Math.max(selectionAnchor, selectionFocus)
        };
      };
      const clearSelection = (): void => {
        selectionAnchor = null;
        selectionFocus = null;
      };
      const setCursor = (next: number, extendSelection = false): void => {
        const clamped = clamp(next, 0, value.length);
        if (extendSelection) {
          if (selectionAnchor === null) {
            selectionAnchor = cursor;
          }
          selectionFocus = clamped;
        } else {
          clearSelection();
        }
        cursor = clamped;
      };
      const replaceSelection = (insertText: string): boolean => {
        const range = selectionRange();
        if (!range) {
          return false;
        }
        value = `${value.slice(0, range.start)}${insertText}${value.slice(range.end)}`;
        cursor = range.start + insertText.length;
        clearSelection();
        return true;
      };
      const innerSize = (): { w: number; h: number } => {
        const coords = (editor as unknown as { _getCoords: () => blessed.Widgets.Coords | undefined })._getCoords();
        if (coords) {
          return {
            w: Math.max(8, coords.xl - coords.xi - 1),
            h: Math.max(4, coords.yl - coords.yi - 1)
          };
        }
        return { w: 80, h: 24 };
      };
      const escapeTagText = (input: string): string => input.replace(/[{}]/g, "");
      const renderVisibleLine = (line: string, lineStart: number, width: number): string => {
        const visibleRaw = line.slice(colOffset, colOffset + width);
        const chars = visibleRaw.split("");
        const range = selectionRange();
        if (range) {
          const lineVisibleStart = lineStart + colOffset;
          const lineVisibleEnd = lineVisibleStart + width;
          const start = Math.max(range.start, lineVisibleStart);
          const end = Math.min(range.end, lineVisibleEnd);
          for (let i = start; i < end; i += 1) {
            const idx = i - lineVisibleStart;
            const ch = chars[idx] ?? " ";
            chars[idx] = `{inverse}${escapeTagText(ch)}{/inverse}`;
          }
        }
        return `${chars.map((ch) => (ch.includes("{") ? ch : escapeTagText(ch))).join("")}${" ".repeat(Math.max(0, width - visibleRaw.length))}`;
      };
      const placeCursor = (): void => {
        const coords = (editor as unknown as { _getCoords: () => blessed.Widgets.Coords | undefined })._getCoords();
        if (!coords) return;
        const { row, col } = indexToRowCol(value, cursor);
        const { w, h } = innerSize();
        const y = coords.yi + 1 + clamp(row - rowOffset, 0, h - 1);
        const x = coords.xi + 1 + clamp(col - colOffset, 0, w - 1);
        this.screen.program.showCursor();
        this.screen.program.cup(y, x);
      };
      const redraw = (): void => {
        const lines = value.split("\n");
        const starts = lineStarts(value);
        const { row, col } = indexToRowCol(value, cursor);
        const { w, h } = innerSize();
        if (row < rowOffset) rowOffset = row;
        if (row > rowOffset + h - 1) rowOffset = row - h + 1;
        if (col < colOffset) colOffset = col;
        if (col > colOffset + w - 1) colOffset = col - w + 1;
        const visible: string[] = [];
        for (let i = 0; i < h; i += 1) {
          const rowIndex = rowOffset + i;
          const line = lines[rowIndex] ?? "";
          const lineStart = starts[rowIndex] ?? value.length;
          visible.push(renderVisibleLine(line, lineStart, w));
        }
        editor.setContent(visible.join("\n"));
        this.screen.render();
        placeCursor();
      };
      const cleanup = (): void => {
        wrapper.removeListener("keypress", onKey);
        editor.removeListener("keypress", onKey);
        this.inputMode = false;
        this.screen.program.hideCursor();
        wrapper.destroy();
        this.updateStatusBar();
        this.screen.render();
      };
      const finish = (result: string | null): void => {
        cleanup();
        resolve(result);
      };
      const pasteClipboard = (): void => {
        const clip = sanitizeEditorInput(readClipboardText());
        if (!clip) {
          return;
        }
        replaceSelection("");
        value = `${value.slice(0, cursor)}${clip}${value.slice(cursor)}`;
        cursor += clip.length;
        preferredCol = null;
        redraw();
      };

      const onKey = (ch: string, key: { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; full?: string }): void => {
        if (key.full === "C-s") {
          finish(value);
          return;
        }
        if (key.full === "C-S-v") {
          pasteClipboard();
          return;
        }
        if (key.name === "escape") {
          finish(null);
          return;
        }
        const rc = indexToRowCol(value, cursor);
        const lines = value.split("\n");
        const { h } = innerSize();

        if (key.name === "left") {
          setCursor(cursor - 1, Boolean(key.shift));
          preferredCol = null;
          redraw();
          return;
        }
        if (key.name === "right") {
          setCursor(cursor + 1, Boolean(key.shift));
          preferredCol = null;
          redraw();
          return;
        }
        if (key.name === "home") {
          setCursor(rowColToIndex(value, rc.row, 0), Boolean(key.shift));
          preferredCol = null;
          redraw();
          return;
        }
        if (key.name === "end") {
          setCursor(rowColToIndex(value, rc.row, lines[rc.row].length), Boolean(key.shift));
          preferredCol = null;
          redraw();
          return;
        }
        if (key.name === "up") {
          const col = preferredCol ?? rc.col;
          preferredCol = col;
          setCursor(rowColToIndex(value, rc.row - 1, col), Boolean(key.shift));
          redraw();
          return;
        }
        if (key.name === "down") {
          const col = preferredCol ?? rc.col;
          preferredCol = col;
          setCursor(rowColToIndex(value, rc.row + 1, col), Boolean(key.shift));
          redraw();
          return;
        }
        if (key.name === "pageup") {
          const col = preferredCol ?? rc.col;
          preferredCol = col;
          setCursor(rowColToIndex(value, rc.row - (h - 1), col), Boolean(key.shift));
          redraw();
          return;
        }
        if (key.name === "pagedown") {
          const col = preferredCol ?? rc.col;
          preferredCol = col;
          setCursor(rowColToIndex(value, rc.row + (h - 1), col), Boolean(key.shift));
          redraw();
          return;
        }
        if (key.name === "backspace") {
          if (replaceSelection("")) {
            preferredCol = null;
            redraw();
            return;
          }
          if (cursor > 0) {
            value = `${value.slice(0, cursor - 1)}${value.slice(cursor)}`;
            cursor -= 1;
            preferredCol = null;
            redraw();
          }
          return;
        }
        if (key.name === "delete") {
          if (replaceSelection("")) {
            preferredCol = null;
            redraw();
            return;
          }
          if (cursor < value.length) {
            value = `${value.slice(0, cursor)}${value.slice(cursor + 1)}`;
            preferredCol = null;
            redraw();
          }
          return;
        }
        if (key.name === "enter" || key.name === "return") {
          replaceSelection("");
          value = `${value.slice(0, cursor)}\n${value.slice(cursor)}`;
          cursor += 1;
          preferredCol = null;
          redraw();
          return;
        }
        if (isPrintable(ch, key)) {
          replaceSelection("");
          const inserted = sanitizeEditorInput(ch);
          if (!inserted) {
            redraw();
            return;
          }
          value = `${value.slice(0, cursor)}${inserted}${value.slice(cursor)}`;
          cursor += inserted.length;
          preferredCol = null;
          redraw();
        }
      };

      wrapper.on("keypress", onKey);
      editor.on("keypress", onKey);
      editor.on("click", () => editor.focus());
      editor.focus();
      redraw();
    });
  }

  private async chooseRepoPath(): Promise<Nullable<string>> {
    const options = ["[Enter New Repo Path]", ...this.config.recentRepos];
    const pick = await this.pickOne("Select Repo", options);
    if (!pick) {
      return null;
    }
    let repoPath = pick;
    if (pick === "[Enter New Repo Path]") {
      const entered = await this.promptInput("Repo path");
      if (!entered) {
        return null;
      }
      repoPath = entered;
    }
    const resolved = path.resolve(repoPath);
    try {
      const stat = await fs.stat(resolved);
      if (!stat.isDirectory()) {
        await this.showMessage("Invalid path", "Path is not a directory.");
        return null;
      }
    } catch {
      await this.showMessage("Invalid path", "Directory does not exist.");
      return null;
    }
    this.config = addRecentRepo(this.config, resolved);
    await writeConfig(this.deps.paths.configPath, this.config);
    return resolved;
  }

  private async browseWorkflowFiles(): Promise<Nullable<{ file: string; workflow: WorkflowDefinition }>> {
    const files = await listWorkflowFiles(this.deps.paths.workflowsDir);
    if (files.length === 0) {
      await this.showMessage("No workflows", "No workflow files found.");
      return null;
    }
    const pick = await this.pickOne("Select Workflow", files);
    if (!pick) {
      return null;
    }
    const workflow = await loadWorkflowFromFile(this.deps.paths.workflowsDir, pick);
    return { file: pick, workflow };
  }

  private async chooseWorkflowAudience(): Promise<Nullable<BuiltinWorkflowAudience>> {
    const inferred = inferBuiltinWorkflowAudience(this.config);
    if (inferred) {
      return inferred;
    }
    const audienceItems: Array<{ label: string; value: BuiltinWorkflowAudience }> = [
      { label: BUILTIN_WORKFLOW_AUDIENCE_LABELS.openai_subscriber, value: "openai_subscriber" },
      { label: BUILTIN_WORKFLOW_AUDIENCE_LABELS.claude_subscriber, value: "claude_subscriber" },
      { label: BUILTIN_WORKFLOW_AUDIENCE_LABELS.api_router_user, value: "api_router_user" }
    ];
    const pick = await this.pickOne(
      "Provider Profile",
      audienceItems.map((item) => item.label)
    );
    if (!pick) {
      return null;
    }
    return audienceItems.find((item) => item.label === pick)?.value ?? null;
  }

  private async chooseBuiltinTemplateDirect(): Promise<Nullable<{ file: string; workflow: WorkflowDefinition }>> {
    const templates = listBuiltinWorkflowTemplates();
    const items = templates.map((template) => ({
      label: `${BUILTIN_WORKFLOW_CATEGORY_LABELS[template.category]} - ${BUILTIN_WORKFLOW_AUDIENCE_LABELS[template.audience]}`,
      template
    }));
    const pick = await this.pickOne(
      "Workflow Template",
      items.map((item) => item.label)
    );
    if (!pick) {
      return null;
    }
    const match = items.find((item) => item.label === pick);
    if (!match) {
      return null;
    }
    return { file: match.template.fileName, workflow: match.template.workflow };
  }

  private async autoSelectWorkflow(task: string): Promise<Nullable<{ file: string; workflow: WorkflowDefinition }>> {
    const audience = await this.chooseWorkflowAudience();
    if (!audience) {
      return null;
    }
    const template = classifyBuiltinWorkflowTemplate(task, audience);
    this.log(`[workflow] Auto-selected ${template.name}.`);
    return { file: template.fileName, workflow: template.workflow };
  }

  private async chooseWorkflow(task: string): Promise<Nullable<{ file: string; workflow: WorkflowDefinition }>> {
    const mode = await this.pickOne("Workflow Source", [
      "Auto-select from task prompt",
      "Pick built-in template",
      "Browse workflow files"
    ]);
    if (!mode) {
      return null;
    }
    if (mode === "Auto-select from task prompt") {
      return this.autoSelectWorkflow(task);
    }
    if (mode === "Pick built-in template") {
      return this.chooseBuiltinTemplateDirect();
    }
    return this.browseWorkflowFiles();
  }

  private async reviewPlanWithUser(request: PlanReviewRequest): Promise<PlanReviewResponse> {
    this.appendMain(
      this.renderWorkspaceBlock("Plan Approval Required", [
        `Step: ${request.stepId}`,
        `Iteration: ${request.iteration}`,
        `Summary: ${request.summary.slice(0, 280)}`
      ])
    );
    const approved = await this.promptPlanApproval(request);
    if (approved) {
      this.log("[plan-review] plan approved.");
      return { approved: true };
    }
    const feedbackRaw = await this.promptInput("Plan feedback", "");
    const feedback = feedbackRaw?.trim() ?? "";
    this.log("[plan-review] plan rejected; requested revision.");
    return { approved: false, feedback };
  }

  private async promptPlanApproval(request: PlanReviewRequest): Promise<boolean> {
    return new Promise((resolve) => {
      this.inputMode = true;
      this.updateStatusBar();
      const workspaceTop = this.mainBox.top ?? 1;
      const workspaceLeft = this.mainBox.left ?? MENU_WIDTH;
      const workspaceWidth = this.mainBox.width ?? WORKSPACE_NARROW_WIDTH;
      const workspaceHeight = this.mainBox.height ?? FULL_PANEL_HEIGHT;
      const wrapper = blessed.box({
        parent: this.screen,
        border: "line",
        width: workspaceWidth,
        height: workspaceHeight,
        top: workspaceTop,
        left: workspaceLeft,
        label: " Plan Review ",
        keys: true,
        mouse: true,
        vi: false,
        style: { border: { fg: "green" } }
      });

      blessed.box({
        parent: wrapper,
        top: 0,
        left: 1,
        width: "100%-2",
        height: 1,
        content: " Up/Down/PgUp/PgDn scroll | A approve | R reject | Esc reject ",
        style: { fg: "yellow" }
      });

      blessed.box({
        parent: wrapper,
        top: 2,
        left: 1,
        width: "100%-2",
        height: 3,
        tags: false,
        content: [
          `Step: ${request.stepId}  Iteration: ${request.iteration}`,
          `Summary: ${request.summary.slice(0, 260)}`
        ].join("\n"),
        style: { fg: "white" }
      });

      const planBody = blessed.box({
        parent: wrapper,
        top: 5,
        left: 1,
        width: "100%-2",
        height: "100%-10",
        border: "line",
        tags: false,
        scrollable: true,
        alwaysScroll: true,
        keys: true,
        mouse: true,
        vi: false,
        content: this.cleanPanelText(request.plan).trim() || "(empty plan output)",
        style: { border: { fg: "cyan" } }
      });

      const actionRow = blessed.box({
        parent: wrapper,
        bottom: 1,
        left: 1,
        width: "100%-2",
        height: 3,
        mouse: true
      });

      const approveButton = blessed.box({
        parent: actionRow,
        top: 0,
        left: 0,
        width: "50%-2",
        height: 3,
        border: "line",
        align: "center",
        valign: "middle",
        content: "Approve [A]"
      });

      const rejectButton = blessed.box({
        parent: actionRow,
        top: 0,
        right: 0,
        width: "50%-2",
        height: 3,
        border: "line",
        align: "center",
        valign: "middle",
        content: "Reject [R]"
      });

      let selectedAction = 0;
      const renderActions = (): void => {
        const selectedStyle = { fg: "black", bg: "white", bold: true };
        const idleStyle = { fg: "white", bg: "black", bold: false };
        approveButton.style = selectedAction === 0 ? selectedStyle : idleStyle;
        rejectButton.style = selectedAction === 1 ? selectedStyle : idleStyle;
        approveButton.style.border = { fg: selectedAction === 0 ? "green" : "cyan" };
        rejectButton.style.border = { fg: selectedAction === 1 ? "green" : "cyan" };
        this.screen.render();
      };

      const setSelection = (next: number): void => {
        if (selectedAction === next) {
          return;
        }
        selectedAction = next;
        renderActions();
      };

      const finish = (approved: boolean): void => {
        wrapper.destroy();
        this.inputMode = false;
        this.updateStatusBar();
        this.screen.render();
        resolve(approved);
      };

      const bindCommonKeys = (target: blessed.Widgets.BoxElement): void => {
        target.key(["escape", "q"], () => finish(false));
        target.key(["left", "h"], () => setSelection(0));
        target.key(["right", "l"], () => setSelection(1));
        target.key(["enter", "return"], () => finish(selectedAction === 0));
        target.key(["a"], () => finish(true));
        target.key(["r"], () => finish(false));
        target.key(["up", "k"], () => {
          planBody.scroll(-1);
          this.screen.render();
        });
        target.key(["down", "j"], () => {
          planBody.scroll(1);
          this.screen.render();
        });
        target.key(["pageup"], () => {
          planBody.scroll(-10);
          this.screen.render();
        });
        target.key(["pagedown"], () => {
          planBody.scroll(10);
          this.screen.render();
        });
        target.key(["home"], () => {
          planBody.setScroll(0);
          this.screen.render();
        });
        target.key(["end"], () => {
          planBody.setScrollPerc(100);
          this.screen.render();
        });
      };

      bindCommonKeys(wrapper);
      bindCommonKeys(planBody);
      bindCommonKeys(actionRow);
      bindCommonKeys(approveButton);
      bindCommonKeys(rejectButton);

      approveButton.on("click", () => finish(true));
      rejectButton.on("click", () => finish(false));
      approveButton.on("mouseover", () => setSelection(0));
      rejectButton.on("mouseover", () => setSelection(1));

      planBody.focus();
      renderActions();
      this.screen.render();
    });
  }

  private async startRunFlow(): Promise<void> {
    const repoPath = await this.chooseRepoPath();
    if (!repoPath) {
      return;
    }
    const task = await this.promptInput("Task description", "Implement requested change safely.");
    if (!task) {
      return;
    }
    const chosen = await this.chooseWorkflow(task);
    if (!chosen) {
      return;
    }
    this.workspaceAutoFollow = true;
    this.traceAutoFollow = true;
    this.clearTrace();
    this.setMainContent(
      [
        this.renderWorkspaceBlock("Run starting", [
          `Repo: ${repoPath}`,
          `Workflow: ${chosen.workflow.name}`,
          `Task: ${task}`
        ]),
        this.renderWorkspaceBlock("Controls", [
          "Tab / Shift+Tab switches focus between panes.",
          "Arrow keys, PgUp/PgDn, Home/End scroll the focused pane.",
          "Trace and Log visibility are controlled in Settings.",
          "Ctrl+P queues an instruction for the next iteration.",
          "Ctrl+X requests a safe stop."
        ])
      ].join("\n\n")
    );
    this.mainBox.focus();
    this.beginRunSession();
    try {
      const result = await executeRun({
        runsRoot: this.deps.paths.runsDir,
        memoryRoot: this.deps.paths.memoryDir,
        repoPath,
        workflow: chosen.workflow,
        task,
        safeMode: this.config.safeMode,
        providerConfig: this.config.providers,
        ui: {
          log: (line) => this.log(line),
          stream: () => {},
          approval: async (request) => {
            this.log(`[auto-approve] ${request.title}`);
            return true;
          },
          planReview: async (request) => this.reviewPlanWithUser(request),
          isTerminationRequested: () => this.terminateRequested,
          consumePendingUserPrompts: () => this.consumeQueuedRunPrompts(),
          event: (event) => this.onRunEvent(event)
        }
      });
      await this.showMessage("Run complete", `Run ${result.runId} finished. Success: ${result.ok}`);
    } finally {
      this.endRunSession();
    }
  }
  private cloneWorkflow(input: WorkflowDefinition): WorkflowDefinition {
    return JSON.parse(JSON.stringify(input)) as WorkflowDefinition;
  }

  private defaultStep(index: number): WorkflowStep {
    return {
      id: `step_${index + 1}`,
      role: "engineer",
      provider: "codex_subscription",
      model: "gpt-5.3-codex",
      reasoningEffort: "medium",
      systemPrompt:
        "Act as an agentic coding step. Use repo context, propose safe changes, and include [STEP_DONE] when complete.",
      promptTemplate: "Describe what should happen for {{task}}.",
      tools: ["filesystem"]
    };
  }

  private getStepIterationLabel(step: WorkflowStep): string {
    void step;
    return "unbounded";
  }

  private parseCsvList(raw: string): string[] {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  private renderWorkflowSummary(fileName: string, workflow: WorkflowDefinition): string {
    const steps = workflow.steps
      .map((s, i) => {
        const gate = s.gate
          ? `Diff approval ${s.gate.requireApprovalForDiff ? "on" : "off"} | External commands ${s.gate.requireApprovalForExternalCommands ? "on" : "off"}`
          : "None";
        const hasSystem = s.systemPrompt?.trim() ? "Y" : "N";
        const reasoning = s.reasoningEffort ?? "medium";
        const tools = s.tools.length > 0 ? s.tools.join(", ") : "(none)";
        return [
          `${i + 1}. ${s.id} (${s.role})`,
          `   Model: ${s.provider}/${s.model}`,
          `   Reasoning: ${reasoning} | Iterations: ${this.getStepIterationLabel(s)}`,
          `   Tools: ${tools}`,
          `   System prompt: ${hasSystem === "Y" ? "Yes" : "No"}`,
          `   Gate: ${gate}`
        ].join("\n");
      })
      .join("\n\n");
    return [
      `Workflow Builder: ${fileName}`,
      "",
      `Name: ${workflow.name}`,
      `Description: ${workflow.description ?? ""}`,
      `Schema Version: ${workflow.schemaVersion ?? 1}`,
      "",
      "Steps:",
      steps || "(none)"
    ].join("\n");
  }

  private async editStepMemory(step: WorkflowStep): Promise<void> {
    while (true) {
      const currentScopes = step.memory?.scopes ?? ["global", "team", "personal"];
      const currentTopK = step.memory?.topK ?? 5;
      const pick = await this.pickOne("Step memory", [
        `Edit scopes (current: ${currentScopes.join(", ")})`,
        `Edit topK (current: ${currentTopK})`,
        "Clear memory config",
        "Back"
      ]);
      if (!pick || pick === "Back") {
        return;
      }
      if (pick.startsWith("Edit scopes")) {
        const input = await this.promptInput(
          "Scopes (comma separated from: global, team, personal)",
          currentScopes.join(", ")
        );
        if (!input) {
          continue;
        }
        const parsed = this.parseCsvList(input).filter(
          (s): s is MemoryScope => s === "global" || s === "team" || s === "personal"
        );
        if (parsed.length === 0) {
          await this.showMessage("Invalid scopes", "Provide at least one valid scope.");
          continue;
        }
        step.memory = { ...(step.memory ?? {}), scopes: parsed };
      } else if (pick.startsWith("Edit topK")) {
        const input = await this.promptInput("topK", String(step.memory?.topK ?? 5));
        if (!input) {
          continue;
        }
        const n = Number.parseInt(input, 10);
        if (!Number.isFinite(n) || n <= 0) {
          await this.showMessage("Invalid number", "topK must be a positive integer.");
          continue;
        }
        step.memory = { ...(step.memory ?? {}), topK: n };
      } else if (pick === "Clear memory config") {
        delete step.memory;
      }
    }
  }

  private async editStepVoting(step: WorkflowStep): Promise<void> {
    const strategy = step.voting?.strategy ?? "none";
    const pick = await this.pickOne("Voting strategy", [
      `none${strategy === "none" ? " (current)" : ""}`,
      `best_of_n_same_model${strategy === "best_of_n_same_model" ? " (current)" : ""}`,
      `cross_model_vote${strategy === "cross_model_vote" ? " (current)" : ""}`,
      `judge_model${strategy === "judge_model" ? " (current)" : ""}`,
      "Back"
    ]);
    if (!pick || pick === "Back") {
      return;
    }

    if (pick.startsWith("none")) {
      delete step.voting;
      return;
    }

    if (pick.startsWith("best_of_n_same_model")) {
      const nRaw = await this.promptInput("N candidates", String(step.voting?.n ?? 2));
      if (!nRaw) {
        return;
      }
      const n = Number.parseInt(nRaw, 10);
      if (!Number.isFinite(n) || n < 2) {
        await this.showMessage("Invalid value", "N must be >= 2.");
        return;
      }
      step.voting = { strategy: "best_of_n_same_model", n };
      return;
    }

    if (pick.startsWith("cross_model_vote")) {
      const existing = (step.voting?.models ?? [{ provider: step.provider, model: step.model }])
        .map((m) => `${m.provider}:${m.model}`)
        .join(", ");
      const modelsRaw = await this.promptInput("Models provider:model,comma-separated", existing);
      if (!modelsRaw) {
        return;
      }
      const models = this.parseCsvList(modelsRaw)
        .map((entry) => entry.split(":").map((s) => s.trim()))
        .filter((pair) => pair.length === 2 && pair[0] && pair[1])
        .map(([provider, model]) => ({ provider, model }));
      if (models.length === 0) {
        await this.showMessage("Invalid models", "Provide at least one provider:model pair.");
        return;
      }
      step.voting = { strategy: "cross_model_vote", models };
      return;
    }

    const nRaw = await this.promptInput("N candidates to judge", String(step.voting?.n ?? 2));
    if (!nRaw) {
      return;
    }
    const n = Number.parseInt(nRaw, 10);
    if (!Number.isFinite(n) || n < 2) {
      await this.showMessage("Invalid value", "N must be >= 2.");
      return;
    }
    const judgeProvider = await this.promptInput("Judge provider", step.voting?.judge?.provider ?? step.provider);
    if (!judgeProvider) {
      return;
    }
    const judgeModel = await this.promptInput("Judge model", step.voting?.judge?.model ?? step.model);
    if (!judgeModel) {
      return;
    }
    step.voting = {
      strategy: "judge_model",
      n,
      judge: { provider: judgeProvider, model: judgeModel }
    };
  }

  private async editStepGate(step: WorkflowStep): Promise<void> {
    const gate: WorkflowGateConfig = step.gate ?? {
      requireApprovalForDiff: true,
      requireApprovalForExternalCommands: true
    };
    while (true) {
      const pick = await this.pickOne("Gate config", [
        `Toggle diff approval (currently ${gate.requireApprovalForDiff ? "ON" : "OFF"})`,
        `Toggle external-command approval (currently ${gate.requireApprovalForExternalCommands ? "ON" : "OFF"})`,
        "Clear gate config",
        "Back"
      ]);
      if (!pick || pick === "Back") {
        step.gate = gate;
        return;
      }
      if (pick.startsWith("Toggle diff approval")) {
        gate.requireApprovalForDiff = !gate.requireApprovalForDiff;
      } else if (pick.startsWith("Toggle external-command approval")) {
        gate.requireApprovalForExternalCommands = !gate.requireApprovalForExternalCommands;
      } else if (pick === "Clear gate config") {
        delete step.gate;
        return;
      }
    }
  }
  private parseToolCalls(raw: string): WorkflowToolCall[] {
    const out: WorkflowToolCall[] = [];
    const lines = raw
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of lines) {
      const [toolRaw, ...rest] = line.split("|");
      const tool = toolRaw.trim();
      const command = rest.join("|").trim();
      if ((tool === "git" || tool === "tests" || tool === "shell") && command) {
        out.push({ tool, command });
      }
    }
    return out;
  }

  private async editStepToolCalls(step: WorkflowStep): Promise<void> {
    const initial = (step.toolCalls ?? []).map((c) => `${c.tool} | ${c.command}`).join("\n");
    const edited = await this.editMultiline(
      "Tool calls (one per line: git|command OR tests|command OR shell|command)",
      initial
    );
    if (edited === null) {
      return;
    }
    const calls = this.parseToolCalls(edited);
    step.toolCalls = calls.length ? calls : undefined;
  }

  private async editStepFlow(stepIn: WorkflowStep): Promise<WorkflowStep | null> {
    const step = JSON.parse(JSON.stringify(stepIn)) as WorkflowStep;
    while (true) {
      this.setMainContent(
        [
          `Editing step: ${step.id}`,
          "",
          `Role: ${step.role}`,
          `Provider/Model: ${step.provider}/${step.model}`,
          `Reasoning effort: ${step.reasoningEffort ?? "medium"}`,
          `Iterations: ${this.getStepIterationLabel(step)}`,
          `System prompt: ${step.systemPrompt ? `${step.systemPrompt.slice(0, 120)}${step.systemPrompt.length > 120 ? "..." : ""}` : "(none)"}`,
          `Tools: ${step.tools.join(", ") || "(none)"}`,
          `Gate: ${step.gate ? JSON.stringify(step.gate) : "none"}`,
          `Memory: ${step.memory ? JSON.stringify(step.memory) : "none"}`,
          `Tool Calls: ${step.toolCalls?.length ?? 0}`,
          "",
          "Prompt template preview:",
          step.promptTemplate.slice(0, 700)
        ].join("\n")
      );

      const pick = await this.pickOne("Edit step", [
        "Edit id",
        "Edit role",
        "Edit provider",
        "Edit model",
        "Edit reasoning effort",
        "Edit system prompt",
        "Edit prompt template",
        "Edit tools",
        "Configure memory",
        "Configure gate",
        "Configure tool calls",
        "Done",
        "Cancel"
      ]);
      if (!pick || pick === "Cancel") {
        return null;
      }
      if (pick === "Done") {
        delete step.iterations;
        return step;
      }
      if (pick === "Edit id") {
        const v = await this.promptInput("Step id", step.id);
        if (v?.trim()) {
          step.id = v.trim();
        }
      } else if (pick === "Edit role") {
        const v = await this.promptInput("Step role", step.role);
        if (v?.trim()) {
          step.role = v.trim();
        }
      } else if (pick === "Edit provider") {
        const providerPick = await this.pickOne("Provider", [
          "mock",
          "codex_api",
          "codex_subscription",
          "claude_subscription",
          "openai_compatible",
          "openrouter",
          "nim",
          "[Custom]"
        ]);
        if (!providerPick) {
          continue;
        }
        if (providerPick === "[Custom]") {
          const v = await this.promptInput("Custom provider", step.provider);
          if (v?.trim()) {
            step.provider = v.trim();
          }
        } else {
          step.provider = providerPick;
        }
      } else if (pick === "Edit model") {
        const v = await this.promptInput("Model", step.model);
        if (v?.trim()) {
          step.model = v.trim();
        }
      } else if (pick === "Edit reasoning effort") {
        const choice = await this.pickOne("Reasoning effort", ["medium", "low", "high"]);
        if (choice === "medium" || choice === "low" || choice === "high") {
          step.reasoningEffort = choice;
        }
      } else if (pick === "Edit system prompt") {
        const v = await this.editMultiline("System prompt", step.systemPrompt ?? "");
        if (v !== null) {
          step.systemPrompt = v.trim() ? v : undefined;
        }
      } else if (pick === "Edit prompt template") {
        const v = await this.editMultiline("Prompt template", step.promptTemplate);
        if (v !== null && v.trim()) {
          step.promptTemplate = v;
        }
      } else if (pick === "Edit tools") {
        const v = await this.promptInput("Tools (comma separated)", step.tools.join(", "));
        if (v !== null) {
          step.tools = this.parseCsvList(v);
        }
      } else if (pick === "Configure memory") {
        await this.editStepMemory(step);
      } else if (pick === "Configure gate") {
        await this.editStepGate(step);
      } else if (pick === "Configure tool calls") {
        await this.editStepToolCalls(step);
      }
    }
  }

  private async manageStepsFlow(workflow: WorkflowDefinition): Promise<void> {
    while (true) {
      const stepLabels = workflow.steps.map((s, i) => `${i + 1}. ${s.id} (${s.role})`);
      const pick = await this.pickOne("Manage steps", [...stepLabels, "Add step", "Back"]);
      if (!pick || pick === "Back") {
        return;
      }
      if (pick === "Add step") {
        const created = this.defaultStep(workflow.steps.length);
        const edited = await this.editStepFlow(created);
        if (edited) {
          workflow.steps.push(edited);
        }
        continue;
      }

      const idx = stepLabels.indexOf(pick);
      if (idx < 0) {
        continue;
      }
      const step = workflow.steps[idx];
      const action = await this.pickOne(`Step "${step.id}"`, [
        "Edit step",
        "Move up",
        "Move down",
        "Delete step",
        "Back"
      ]);
      if (!action || action === "Back") {
        continue;
      }
      if (action === "Edit step") {
        const edited = await this.editStepFlow(step);
        if (edited) {
          workflow.steps[idx] = edited;
        }
      } else if (action === "Move up" && idx > 0) {
        const tmp = workflow.steps[idx - 1];
        workflow.steps[idx - 1] = workflow.steps[idx];
        workflow.steps[idx] = tmp;
      } else if (action === "Move down" && idx < workflow.steps.length - 1) {
        const tmp = workflow.steps[idx + 1];
        workflow.steps[idx + 1] = workflow.steps[idx];
        workflow.steps[idx] = tmp;
      } else if (action === "Delete step") {
        const ok = await this.askConfirm("Delete step", `Delete step "${step.id}"?`);
        if (ok) {
          workflow.steps.splice(idx, 1);
        }
      }
    }
  }

  private async workflowBuilderFlow(
    fileName: string,
    initial: WorkflowDefinition,
    allowDelete: boolean
  ): Promise<WorkflowDefinition | null> {
    const workflow = this.cloneWorkflow(initial);
    if (!workflow.schemaVersion) {
      workflow.schemaVersion = 1;
    }
    if (!workflow.steps) {
      workflow.steps = [];
    }

    while (true) {
      this.setMainContent(this.renderWorkflowSummary(fileName, workflow));
      const options = [
        "Edit name",
        "Edit description",
        "Manage steps",
        "Save workflow",
        "Cancel"
      ];
      if (allowDelete) {
        options.splice(3, 0, "Delete workflow");
      }
      const pick = await this.pickOne("Workflow builder", options);
      if (!pick || pick === "Cancel") {
        return null;
      }
      if (pick === "Edit name") {
        const value = await this.promptInput("Workflow name", workflow.name);
        if (value?.trim()) {
          workflow.name = value.trim();
        }
      } else if (pick === "Edit description") {
        const value = await this.editMultiline("Workflow description", workflow.description ?? "");
        if (value !== null) {
          workflow.description = value.trim() || undefined;
        }
      } else if (pick === "Manage steps") {
        await this.manageStepsFlow(workflow);
      } else if (pick === "Delete workflow") {
        return this.cloneWorkflow({
          schemaVersion: workflow.schemaVersion,
          name: "__DELETE_WORKFLOW__",
          description: fileName,
          steps: []
        });
      } else if (pick === "Save workflow") {
        try {
          parseWorkflowYaml(yamlStringify(workflow));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await this.showMessage("Validation error", message);
          continue;
        }
        return workflow;
      }
    }
  }

  private async editWorkflowFlow(): Promise<void> {
    const files = await listWorkflowFiles(this.deps.paths.workflowsDir);
    const options = [...files, "[Create New Workflow]"];
    const pick = await this.pickOne("Workflow Editor", options);
    if (!pick) {
      return;
    }

    let fileName = pick;
    let initial = parseWorkflowYaml(EXAMPLE_WORKFLOW_YAML);
    let allowDelete = true;
    if (pick === "[Create New Workflow]") {
      const entered = await this.promptInput("New workflow filename (.yaml)", "custom.yaml");
      if (!entered) {
        return;
      }
      fileName = entered.endsWith(".yaml") || entered.endsWith(".yml") ? entered : `${entered}.yaml`;
      initial.name = "New Workflow";
      initial.description = "Created in Orchestra workflow builder.";
      allowDelete = false;
    } else {
      const current = await readWorkflowText(this.deps.paths.workflowsDir, fileName);
      initial = parseWorkflowYaml(current);
    }

    const edited = await this.workflowBuilderFlow(fileName, initial, allowDelete);
    if (!edited) {
      return;
    }
    if (edited.name === "__DELETE_WORKFLOW__") {
      const ok = await this.askConfirm("Delete workflow", `Delete workflow "${fileName}"?`);
      if (!ok) {
        return;
      }
      await fs.unlink(path.join(this.deps.paths.workflowsDir, fileName));
      await this.showMessage("Deleted", `${fileName} deleted.`);
      this.log(`Workflow deleted: ${fileName}`);
      return;
    }
    const yamlText = yamlStringify(edited);
    await writeWorkflowText(this.deps.paths.workflowsDir, fileName, yamlText);
    await this.showMessage("Saved", `${fileName} saved.`);
    this.log(`Workflow saved: ${fileName}`);
  }
  private async manageMemoryFlow(): Promise<void> {
    while (true) {
      const pick = await this.pickOne("Memory", ["Add item", "Search", "Browse by scope", "Back"]);
      if (!pick || pick === "Back") {
        return;
      }
      if (pick === "Add item") {
        await this.addMemoryFlow();
      } else if (pick === "Search") {
        await this.searchMemoryFlow();
      } else if (pick === "Browse by scope") {
        await this.browseMemoryFlow();
      }
    }
  }

  private async addMemoryFlow(): Promise<void> {
    const scope = await this.pickOne("Scope", ["global", "team", "personal"]);
    if (!scope || (scope !== "global" && scope !== "team" && scope !== "personal")) {
      return;
    }
    const method = await this.pickOne("Input method", ["Paste text", "Import file"]);
    if (!method) {
      return;
    }
    let content = "";
    if (method === "Paste text") {
      const edited = await this.editMultiline("Memory content", "");
      if (edited === null) {
        return;
      }
      content = edited;
    } else {
      const filePath = await this.promptInput("Import file path");
      if (!filePath) {
        return;
      }
      try {
        content = await fs.readFile(path.resolve(filePath), "utf8");
      } catch {
        await this.showMessage("Import error", "Failed to read file.");
        return;
      }
    }
    const tagsRaw = await this.promptInput("Optional tags (comma separated)", "");
    const tags = (tagsRaw ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    try {
      const item = await addMemoryItem(this.deps.paths.memoryDir, scope, content, tags);
      await this.showMessage("Memory saved", `Saved memory item ${item.id} in ${scope}.`);
    } catch (err) {
      await this.showMessage("Memory error", err instanceof Error ? err.message : String(err));
    }
  }

  private async searchMemoryFlow(): Promise<void> {
    const query = await this.promptInput("Search query");
    if (!query) {
      return;
    }
    const scopePick = await this.pickOne("Scope filter", ["all", "global", "team", "personal"]);
    if (!scopePick) {
      return;
    }
    if (scopePick !== "all" && scopePick !== "global" && scopePick !== "team" && scopePick !== "personal") {
      return;
    }
    const scopes: Array<"global" | "team" | "personal"> =
      scopePick === "all" ? ["global", "team", "personal"] : [scopePick];
    const results = await searchMemory(this.deps.paths.memoryDir, query, [...scopes], 20);
    const view = results.length
      ? results
          .map((r) => `(${r.score}) [${r.scope}] ${r.id}\n${r.content.slice(0, 220)}\n`)
          .join("\n")
      : "No matches.";
    this.setMainContent(view);
  }

  private async browseMemoryFlow(): Promise<void> {
    const scope = await this.pickOne("Scope", ["global", "team", "personal"]);
    if (!scope || (scope !== "global" && scope !== "team" && scope !== "personal")) {
      return;
    }
    const items = await listMemoryByScope(this.deps.paths.memoryDir, scope);
    if (items.length === 0) {
      await this.showMessage("Memory", "No items in this scope.");
      return;
    }
    const labels = items.map((i) => `${i.createdAt} | ${i.id} | ${i.content.slice(0, 50).replace(/\s+/g, " ")}`);
    const pick = await this.pickOne("Memory items", labels);
    if (!pick) {
      return;
    }
    const idx = labels.indexOf(pick);
    if (idx < 0) {
      return;
    }
    const item = items[idx];
    this.setMainContent(
      `ID: ${item.id}\nScope: ${item.scope}\nCreated: ${item.createdAt}\nTags: ${(item.tags ?? []).join(", ")}\n\n${item.content}`
    );
  }

  private async viewRunsFlow(): Promise<void> {
    const runs = await listRuns(this.deps.paths.runsDir);
    if (runs.length === 0) {
      await this.showMessage("Runs", "No runs found.");
      return;
    }
    const runId = await this.pickOne("Select run", runs);
    if (!runId) {
      return;
    }

    while (true) {
      const action = await this.pickOne("Run actions", [
        "Timeline (summary)",
        "Timeline (full JSON)",
        "Artifacts",
        "Replay run",
        "Back"
      ]);
      if (!action || action === "Back") {
        return;
      }
      if (action === "Timeline (summary)") {
        const events = await readRunEvents(this.deps.paths.runsDir, runId);
        const text = events
          .map((e) => `${e.ts} [${e.type}] step=${e.stepId ?? "-"} data=${JSON.stringify(e.data)}`)
          .join("\n");
        this.setMainContent(text || "No events.");
      } else if (action === "Timeline (full JSON)") {
        const events = await readRunEvents(this.deps.paths.runsDir, runId);
        const text = events.map((e) => JSON.stringify(e, null, 2)).join("\n\n");
        this.setMainContent(text || "No events.");
      } else if (action === "Artifacts") {
        const artifacts = await listArtifacts(this.deps.paths.runsDir, runId);
        if (artifacts.length === 0) {
          await this.showMessage("Artifacts", "No artifacts for this run.");
          continue;
        }
        const rel = artifacts.map((a) => path.basename(a));
        const pick = await this.pickOne("Artifacts", rel);
        if (!pick) {
          continue;
        }
        const file = artifacts.find((a) => path.basename(a) === pick);
        if (!file) {
          continue;
        }
        const raw = await fs.readFile(file, "utf8");
        this.setMainContent(raw);
      } else if (action === "Replay run") {
        await this.replayRunFlow(runId);
      }
    }
  }

  private async replayRunFlow(runId: string): Promise<void> {
    const meta = await readRunMeta(this.deps.paths.runsDir, runId);
    if (!meta) {
      await this.showMessage("Replay", "Run metadata not found.");
      return;
    }
    let workflow = meta.workflow;
    const remap = await this.askConfirm("Replay", "Remap provider/model for all steps?");
    if (remap) {
      const provider = await this.promptInput("Provider", workflow.steps[0]?.provider ?? "mock");
      if (!provider) {
        return;
      }
      const model = await this.promptInput("Model", workflow.steps[0]?.model ?? "gpt-5.3-codex");
      if (!model) {
        return;
      }
      workflow = {
        ...workflow,
        steps: workflow.steps.map((s) => ({ ...s, provider, model }))
      };
    }
    const task = await this.promptInput("Replay task", meta.task ?? "Replay previous run");
    if (!task) {
      return;
    }

    this.workspaceAutoFollow = true;
    this.traceAutoFollow = true;
    this.clearTrace();
    this.setMainContent(
      [
        this.renderWorkspaceBlock("Replay starting", [
          `Run: ${runId}`,
          `Repo: ${meta.repoPath}`,
          `Workflow: ${workflow.name}`,
          `Task: ${task}`
        ]),
        this.renderWorkspaceBlock("Controls", [
          "Tab / Shift+Tab switches focus between panes.",
          "Arrow keys, PgUp/PgDn, Home/End scroll the focused pane.",
          "Trace and Log visibility are controlled in Settings.",
          "Ctrl+P queues an instruction for the next iteration.",
          "Ctrl+X requests a safe stop."
        ])
      ].join("\n\n")
    );
    this.mainBox.focus();
    this.beginRunSession();
    try {
      const result = await executeRun({
        runsRoot: this.deps.paths.runsDir,
        memoryRoot: this.deps.paths.memoryDir,
        repoPath: meta.repoPath,
        workflow,
        task,
        safeMode: this.config.safeMode,
        providerConfig: this.config.providers,
        ui: {
          log: (line) => this.log(line),
          stream: () => {},
          approval: async (request) => {
            this.log(`[auto-approve] ${request.title}`);
            return true;
          },
          planReview: async (request) => this.reviewPlanWithUser(request),
          isTerminationRequested: () => this.terminateRequested,
          consumePendingUserPrompts: () => this.consumeQueuedRunPrompts(),
          event: (event) => this.onRunEvent(event)
        }
      });
      await this.showMessage("Replay complete", `Run ${result.runId} finished. Success: ${result.ok}`);
    } finally {
      this.endRunSession();
    }
  }

  private async settingsFlow(): Promise<void> {
    while (true) {
      const pick = await this.pickOne("Settings", [
        `Toggle safe mode (currently ${this.config.safeMode ? "ON" : "OFF"})`,
        `Toggle Trace pane (currently ${this.traceVisible ? "ON" : "OFF"})`,
        `Toggle Log pane (currently ${this.logVisible ? "ON" : "OFF"})`,
        `Toggle Codex API adapter (currently ${this.config.providers.codexApi?.enabled !== false ? "ON" : "OFF"})`,
        "Set Codex API key",
        "Set Codex API base URL",
        "Set Codex API default model",
        "Set OpenAI-compatible API key",
        "Set OpenAI-compatible base URL",
        "Set OpenAI-compatible default model",
        "Set OpenRouter API key",
        "Set OpenRouter referer/title",
        "Set OpenRouter default model",
        "Set NVIDIA NIM API key",
        "Set NVIDIA NIM default model",
        `Toggle Codex subscription adapter (currently ${this.config.providers.codexSubscription?.enabled !== false ? "ON" : "OFF"})`,
        `Set Codex transport (currently ${(this.config.providers.codexSubscription?.transport ?? "cli").toUpperCase()})`,
        "Set Codex subscription API base URL",
        "Set Codex command path",
        `Toggle Claude subscription adapter (currently ${this.config.providers.claudeSubscription?.enabled !== false ? "ON" : "OFF"})`,
        "Set Claude command path",
        "View settings",
        "Back"
      ]);
      if (!pick || pick === "Back") {
        return;
      }
      if (pick.startsWith("Toggle safe mode")) {
        this.config.safeMode = !this.config.safeMode;
        await writeConfig(this.deps.paths.configPath, this.config);
        this.log(`Safe mode now ${this.config.safeMode ? "ON" : "OFF"}`);
      } else if (pick.startsWith("Toggle Trace pane")) {
        this.setTraceVisible(!this.traceVisible);
      } else if (pick.startsWith("Toggle Log pane")) {
        this.setLogVisible(!this.logVisible);
      } else if (pick.startsWith("Toggle Codex API adapter")) {
        const current = this.config.providers.codexApi?.enabled !== false;
        this.config.providers.codexApi = {
          ...(this.config.providers.codexApi ?? {}),
          enabled: !current
        };
        await writeConfig(this.deps.paths.configPath, this.config);
      } else if (pick === "Set Codex API key") {
        await this.setCodexApiKey();
      } else if (pick === "Set Codex API base URL") {
        await this.setCodexApiBaseUrl();
      } else if (pick === "Set Codex API default model") {
        await this.setProviderDefaultModel("codexApi", "gpt-5.3-codex");
      } else if (pick === "Set OpenAI-compatible API key") {
        await this.setOpenAICompatibleApiKey();
      } else if (pick === "Set OpenAI-compatible base URL") {
        await this.setOpenAICompatibleBaseUrl();
      } else if (pick === "Set OpenAI-compatible default model") {
        await this.setProviderDefaultModel("openaiCompatible", "gpt-4.1-mini");
      } else if (pick === "Set OpenRouter API key") {
        await this.setOpenRouterApiKey();
      } else if (pick === "Set OpenRouter referer/title") {
        await this.setOpenRouterHeaders();
      } else if (pick === "Set OpenRouter default model") {
        await this.setProviderDefaultModel("openrouter", "openai/gpt-4o-mini");
      } else if (pick === "Set NVIDIA NIM API key") {
        await this.setNimApiKey();
      } else if (pick === "Set NVIDIA NIM default model") {
        await this.setProviderDefaultModel("nim", "meta/llama-3.1-70b-instruct");
      } else if (pick.startsWith("Toggle Codex subscription adapter")) {
        const current = this.config.providers.codexSubscription?.enabled !== false;
        this.config.providers.codexSubscription = {
          ...(this.config.providers.codexSubscription ?? {}),
          enabled: !current
        };
        await writeConfig(this.deps.paths.configPath, this.config);
      } else if (pick.startsWith("Set Codex transport")) {
        const transport = await this.pickOne("Codex transport", ["cli", "api"]);
        if (!transport) {
          continue;
        }
        this.config.providers.codexSubscription = {
          ...(this.config.providers.codexSubscription ?? {}),
          transport: transport === "api" ? "api" : "cli"
        };
        await writeConfig(this.deps.paths.configPath, this.config);
      } else if (pick === "Set Codex subscription API base URL") {
        await this.setCodexSubscriptionApiBaseUrl();
      } else if (pick === "Set Codex command path") {
        await this.setSubscriptionCommand("codexSubscription", "codex");
      } else if (pick.startsWith("Toggle Claude subscription adapter")) {
        const current = this.config.providers.claudeSubscription?.enabled !== false;
        this.config.providers.claudeSubscription = {
          ...(this.config.providers.claudeSubscription ?? {}),
          enabled: !current
        };
        await writeConfig(this.deps.paths.configPath, this.config);
      } else if (pick === "Set Claude command path") {
        await this.setSubscriptionCommand("claudeSubscription", "claude");
      } else if (pick === "View settings") {
        const view = JSON.stringify(
          {
            ...this.config,
            providers: {
              ...this.config.providers,
              openaiCompatible: {
                ...this.config.providers.openaiCompatible,
                apiKey: this.config.providers.openaiCompatible?.apiKey ? "[REDACTED]" : ""
              },
              openrouter: {
                ...this.config.providers.openrouter,
                apiKey: this.config.providers.openrouter?.apiKey ? "[REDACTED]" : ""
              },
              nim: {
                ...this.config.providers.nim,
                apiKey: this.config.providers.nim?.apiKey ? "[REDACTED]" : ""
              },
              codexApi: {
                ...this.config.providers.codexApi,
                apiKey: this.config.providers.codexApi?.apiKey ? "[REDACTED]" : ""
              },
              openai: { apiKey: this.config.providers.openai?.apiKey ? "[REDACTED]" : "" },
              anthropic: { apiKey: this.config.providers.anthropic?.apiKey ? "[REDACTED]" : "" },
              google: { apiKey: this.config.providers.google?.apiKey ? "[REDACTED]" : "" }
            }
          },
          null,
          2
        );
        this.setMainContent(view);
      }
    }
  }

  private async setOpenAICompatibleApiKey(): Promise<void> {
    const key = await this.promptInput("Set OpenAI-compatible key (blank clears)", "", { censor: true });
    if (key === null) {
      return;
    }
    const safe = key.trim();
    this.config.providers.openaiCompatible = {
      ...(this.config.providers.openaiCompatible ?? {}),
      apiKey: safe || undefined
    };
    await writeConfig(this.deps.paths.configPath, this.config);
    this.log("OpenAI-compatible key updated.");
  }

  private async setCodexApiKey(): Promise<void> {
    const key = await this.promptInput("Set Codex API key (blank clears)", "", { censor: true });
    if (key === null) {
      return;
    }
    const safe = key.trim();
    this.config.providers.codexApi = {
      ...(this.config.providers.codexApi ?? {}),
      apiKey: safe || undefined
    };
    await writeConfig(this.deps.paths.configPath, this.config);
    this.log("Codex API key updated.");
  }

  private async setCodexApiBaseUrl(): Promise<void> {
    const current = this.config.providers.codexApi?.baseUrl ?? "https://api.openai.com/v1";
    const value = await this.promptInput("Codex API base URL", current);
    if (value === null) {
      return;
    }
    this.config.providers.codexApi = {
      ...(this.config.providers.codexApi ?? {}),
      baseUrl: value.trim() || "https://api.openai.com/v1"
    };
    await writeConfig(this.deps.paths.configPath, this.config);
  }

  private async setCodexSubscriptionApiBaseUrl(): Promise<void> {
    const current = this.config.providers.codexSubscription?.apiBaseUrl ?? "https://chatgpt.com/backend-api/codex";
    const value = await this.promptInput("Codex subscription API base URL", current);
    if (value === null) {
      return;
    }
    this.config.providers.codexSubscription = {
      ...(this.config.providers.codexSubscription ?? {}),
      apiBaseUrl: value.trim() || "https://chatgpt.com/backend-api/codex"
    };
    await writeConfig(this.deps.paths.configPath, this.config);
  }

  private async setOpenAICompatibleBaseUrl(): Promise<void> {
    const current = this.config.providers.openaiCompatible?.baseUrl ?? "https://api.openai.com/v1";
    const value = await this.promptInput("OpenAI-compatible base URL", current);
    if (value === null) {
      return;
    }
    this.config.providers.openaiCompatible = {
      ...(this.config.providers.openaiCompatible ?? {}),
      baseUrl: value.trim() || "https://api.openai.com/v1"
    };
    await writeConfig(this.deps.paths.configPath, this.config);
  }

  private async setOpenRouterApiKey(): Promise<void> {
    const key = await this.promptInput("Set OpenRouter key (blank clears)", "", { censor: true });
    if (key === null) {
      return;
    }
    this.config.providers.openrouter = {
      ...(this.config.providers.openrouter ?? {}),
      apiKey: key.trim() || undefined
    };
    await writeConfig(this.deps.paths.configPath, this.config);
  }

  private async setOpenRouterHeaders(): Promise<void> {
    const referer = await this.promptInput(
      "OpenRouter HTTP-Referer (blank clears)",
      this.config.providers.openrouter?.referer ?? ""
    );
    if (referer === null) {
      return;
    }
    const title = await this.promptInput(
      "OpenRouter X-Title (blank clears)",
      this.config.providers.openrouter?.title ?? ""
    );
    if (title === null) {
      return;
    }
    this.config.providers.openrouter = {
      ...(this.config.providers.openrouter ?? {}),
      referer: referer.trim() || undefined,
      title: title.trim() || undefined
    };
    await writeConfig(this.deps.paths.configPath, this.config);
  }

  private async setNimApiKey(): Promise<void> {
    const key = await this.promptInput("Set NVIDIA NIM key (blank clears)", "", { censor: true });
    if (key === null) {
      return;
    }
    this.config.providers.nim = {
      ...(this.config.providers.nim ?? {}),
      apiKey: key.trim() || undefined
    };
    await writeConfig(this.deps.paths.configPath, this.config);
  }

  private async setProviderDefaultModel(
    provider: "codexApi" | "openaiCompatible" | "openrouter" | "nim",
    placeholder: string
  ): Promise<void> {
    const current = this.config.providers[provider]?.defaultModel ?? placeholder;
    const value = await this.promptInput(`Default model for ${provider}`, current);
    if (value === null) {
      return;
    }
    this.config.providers[provider] = {
      ...(this.config.providers[provider] ?? {}),
      defaultModel: value.trim() || undefined
    };
    await writeConfig(this.deps.paths.configPath, this.config);
  }

  private async setSubscriptionCommand(
    provider: "codexSubscription" | "claudeSubscription",
    placeholder: string
  ): Promise<void> {
    const current = this.config.providers[provider]?.command ?? placeholder;
    const value = await this.promptInput(`Command for ${provider}`, current);
    if (value === null) {
      return;
    }
    this.config.providers[provider] = {
      ...(this.config.providers[provider] ?? {}),
      command: value.trim() || placeholder
    };
    await writeConfig(this.deps.paths.configPath, this.config);
  }
}

export async function bootstrapAndRun(paths: OrchestraPaths): Promise<void> {
  const config = await readConfig(paths.configPath);
  const app = new OrchestraTuiApp({ paths, config });
  app.start();
}
