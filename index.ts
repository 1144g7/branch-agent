import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { spawn } from "child_process";

// ---- Constants ----
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const TOOL_DISPLAY: Record<string, string> = {
  read: "reading",
  bash: "running command",
  edit: "editing",
  write: "writing",
  grep: "searching",
  find: "finding files",
  ls: "listing",
};

// ---- Types ----
interface AgentRecord {
  id: string;
  description: string;
  session: any;
  status: "running" | "done" | "error" | "aborted";
  resultText: string;
  error?: string;
  toolUses: number;
  activeTools: Map<string, string>;
  turnCount: number;
  startedAt: number;
  completedAt?: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  forkedPath?: string;
}

interface BranchDetails {
  description: string;
  toolUses: number;
  turnCount: number;
  durationMs: number;
  status: "running" | "completed" | "error" | "aborted" | "background";
  activity?: string;
  spinnerFrame?: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  agentId?: string;
  error?: string;
}

// ---- State ----
const agents = new Map<string, AgentRecord>();
let agentCounter = 0;

// ---- Helpers ----
function genId(): string {
  return `branch-${Date.now()}-${++agentCounter}`;
}

function formatMs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return `${count}`;
}

function describeActivity(activeTools: Map<string, string>, responseText?: string): string {
  if (activeTools.size > 0) {
    const groups = new Map<string, number>();
    for (const toolName of activeTools.values()) {
      const action = TOOL_DISPLAY[toolName] ?? toolName;
      groups.set(action, (groups.get(action) ?? 0) + 1);
    }
    const parts: string[] = [];
    for (const [action, count] of groups) {
      parts.push(count > 1 ? `${action} ${count}x` : action);
    }
    return parts.join(", ") + "…";
  }
  if (responseText && responseText.trim().length > 0) {
    const line = responseText.split("\n").find((l) => l.trim())?.trim() ?? "";
    return line.length > 60 ? line.slice(0, 60) + "…" : line;
  }
  return "thinking…";
}

function cachePercent(record: AgentRecord): number {
  return record.totalTokens > 0
    ? Math.round((record.cacheRead / record.totalTokens) * 100)
    : 0;
}

function cacheText(record: AgentRecord): string {
  if (record.totalTokens === 0) return "";
  const pct = cachePercent(record);
  return `${formatTokens(record.cacheRead)} cached · ${pct}% hit`;
}

function statsLine(d: BranchDetails, theme: any): string {
  const parts: string[] = [];
  if (d.turnCount > 0) parts.push(`⟳${d.turnCount}`);
  if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
  if (d.totalTokens > 0) {
    const pct = d.totalTokens > 0 ? Math.round((d.cacheRead / d.totalTokens) * 100) : 0;
    parts.push(`${formatTokens(d.cacheRead)} cached (${pct}%)`);
  }
  return parts.map((p) => theme.fg("dim", p)).join(" " + theme.fg("dim", "·") + " ");
}

function textResult(msg: string, details?: BranchDetails) {
  return { content: [{ type: "text" as const, text: msg }], details: details as any };
}

// ---- Tree integration ----
// ABANDONED: Writing anything to parent SessionManager pollutes the main conversation.
// Pi has no "tree-only" entry type. The only clean way would be for pi core to
// support this (e.g., a hook that fires after the current turn completes).
// For now, the forked session has parentSession in its header for manual lookup.

// ---- Terminal spawn ----
function openTerminal(forkedPath: string, description: string, prompt: string) {
  // Prefix with branch context — like a branch-context prompt prefix
  const fullPrompt = `[Branch Agent] 你是从主会话 fork 出来的分支。任务: ${description}\n\n${prompt}`;
  const escapedPrompt = fullPrompt.split('"').join('\\"');
  // --no-extensions prevents the sub-agent from loading BranchAgent and recursing
  const child = spawn(
    `start "Branch: ${description}" cmd /k pi --no-extensions --session "${forkedPath}" "${escapedPrompt}"`,
    [],
    { shell: true, stdio: "ignore", detached: true, windowsHide: false }
  );
  child.unref();
}

// ---- Shared clone logic ----
async function createCloneSession(ctx: any): Promise<{ session: any; forkedPath?: string; historyCount: number }> {
  const parentSystemPrompt = ctx.getSystemPrompt();
  const agentDir = getAgentDir();

  const loader = new DefaultResourceLoader({
    cwd: ctx.cwd,
    agentDir,
    noContextFiles: true,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPromptOverride: () => parentSystemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();

  const sourceFile = ctx.sessionManager.getSessionFile();
  if (!sourceFile) {
    // Fallback: in-memory for ephemeral sessions
    const { session } = await createAgentSession({
      cwd: ctx.cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(ctx.cwd),
      settingsManager: SettingsManager.create(ctx.cwd, agentDir),
      modelRegistry: ctx.modelRegistry,
      model: ctx.model,
      resourceLoader: loader,
    });
    return { session, historyCount: 0 };
  }

  const forkedSM = SessionManager.forkFrom(sourceFile, ctx.cwd);
  const forkedPath = forkedSM.getSessionFile();

  const { session } = await createAgentSession({
    cwd: ctx.cwd,
    agentDir,
    sessionManager: forkedSM,
    settingsManager: SettingsManager.create(ctx.cwd, agentDir),
    modelRegistry: ctx.modelRegistry,
    model: ctx.model,
    resourceLoader: loader,
  });
  // Record how many messages came from the fork (so collectResult skips them)
  const historyCount = session.messages.length;
  return { session, forkedPath, historyCount };
}

function collectResult(session: any, skipCount: number = 0): string {
  // Only look at messages after skipCount — skip the forked history
  const messages = session.messages;
  
  // First pass: look for assistant text
  for (let i = messages.length - 1; i >= skipCount; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      const text = msg.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text ?? "")
        .join("\n")
        .trim();
      if (text) return text;
    }
  }
  
  // Second pass: look for tool results as fallback
  for (let i = messages.length - 1; i >= skipCount; i--) {
    const msg = messages[i];
    if (msg.role === "toolResult") {
      const text = msg.content
        ?.filter((c: any) => c.type === "text")
        .map((c: any) => c.text ?? "")
        .join("\n")
        .trim();
      if (text) return text.slice(0, 500);
    }
  }
  
  return "(completed)";
}

// ---- Widget ----
let widgetUi: any = null;
let widgetFrame = 0;
let widgetInterval: ReturnType<typeof setInterval> | undefined;
let widgetRegistered = false;
let widgetTui: any = null;

function updateWidget() {
  if (!widgetUi) return;
  const all = [...agents.values()];
  const running = all.filter((a) => a.status === "running");
  const hasActive = running.length > 0;

  if (!hasActive) {
    if (widgetRegistered) {
      widgetUi.setWidget("branch-agent", undefined);
      widgetRegistered = false;
      widgetTui = null;
    }
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = undefined;
    }
    return;
  }

  widgetFrame++;

  if (!widgetRegistered) {
    widgetUi.setWidget(
      "branch-agent",
      (tui: any, theme: any) => {
        widgetTui = tui;
        return {
          render: () => renderWidget(tui, theme),
          invalidate: () => {
            widgetRegistered = false;
            widgetTui = null;
          },
        };
      },
      { placement: "aboveEditor" }
    );
    widgetRegistered = true;
  } else {
    widgetTui?.requestRender?.();
  }
}

function renderWidget(tui: any, theme: any): string[] {
  const all = [...agents.values()];
  const running = all.filter((a) => a.status === "running");

  if (running.length === 0) return [];

  const w = tui.terminal?.columns ?? 80;
  const frame = SPINNER[widgetFrame % SPINNER.length];

  const lines: string[] = [
    theme.fg("accent", "●") + " " + theme.fg("accent", "Branch Agent"),
  ];

  for (const a of running) {
    const elapsed = formatMs(Date.now() - a.startedAt);
    const activity = describeActivity(a.activeTools, a.resultText);
    const parts: string[] = [];
    if (a.turnCount > 0) parts.push(`⟳${a.turnCount}`);
    if (a.toolUses > 0) parts.push(`${a.toolUses} tool use${a.toolUses === 1 ? "" : "s"}`);
    if (a.totalTokens > 0) parts.push(cacheText(a));
    parts.push(elapsed);
    const statsStr = parts.join(" · ");

    lines.push(
      theme.fg("dim", "├─") +
        ` ${theme.fg("accent", frame)} ${theme.fg("muted", a.description)} ${theme.fg("dim", "·")} ${theme.fg("dim", statsStr)}`
    );
    lines.push(theme.fg("dim", "│  ") + theme.fg("dim", `  ⎿  ${activity}`));
  }

  // Fix last connector
  if (lines.length > 2) {
    lines[lines.length - 2] = lines[lines.length - 2].replace("├─", "└─");
    lines[lines.length - 1] = lines[lines.length - 1].replace("│  ", "   ");
  }

  return lines;
}

function ensureWidgetTimer() {
  if (!widgetInterval) {
    widgetInterval = setInterval(() => updateWidget(), 80);
  }
}

// ---- Extension ----
export default function (pi: ExtensionAPI) {
  // Register custom message renderer for branch-agent results
  pi.registerMessageRenderer("branch-agent-result", (message: any, options: any, theme: any) => {
    const d = message.details;
    if (!d) return undefined;
    const isError = !!d.error;
    const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
    const duration = d.durationMs ? formatMs(d.durationMs) : "";
    const cache = d.totalTokens > 0 ? ` · ${formatTokens(d.cacheRead)} cached (${d.cachePercent}%)` : "";

    let line = `${icon} ${theme.bold(d.description)}`;
    if (duration) line += ` ${theme.fg("dim", duration)}`;
    if (cache) line += theme.fg("dim", cache);

    if (options.expanded) {
      const text = typeof message.content === "string" ? message.content : "";
      if (text) {
        for (const l of text.split("\n").slice(0, 30)) {
          line += "\n" + theme.fg("dim", `  ${l}`);
        }
      }
    }
    return new Text(line, 0, 0);
  });

  pi.registerTool({
    name: "BranchAgent",
    label: "Branch Agent",
    description:
      "缓存优化的分身 Agent，完全继承父会话的上下文以命中前缀缓存。" +
      "mode=foreground 阻塞等待结果；mode=background 后台运行；mode=terminal 后台运行并弹出独立终端窗口。",
    parameters: Type.Object({
      prompt: Type.String({ description: "The task for the branch agent" }),
      description: Type.String({
        description: "Short 3-5 word description of the task",
      }),
      mode: Type.Optional(
        Type.String({
          description: "foreground = block and return result (default). background = run in background. terminal = background + open new terminal window.",
          default: "foreground",
        })
      ),
    }),

    // ---- Custom rendering ----
    renderCall(args: any, theme: any) {
      const desc = args.description ?? "";
      return new Text("▸ " + theme.fg("toolTitle", theme.bold("BranchAgent")) + (desc ? "  " + theme.fg("muted", desc) : ""), 0, 0);
    },

    renderResult(result: any, { expanded, isPartial }: any, theme: any) {
      const details = result.details as BranchDetails | undefined;
      if (!details) {
        const text = result.content[0]?.type === "text" ? result.content[0].text : "";
        return new Text(text, 0, 0);
      }

      // Running (streaming)
      if (isPartial || details.status === "running") {
        const frame = SPINNER[details.spinnerFrame ?? 0];
        const s = statsLine(details, theme);
        let line = theme.fg("accent", frame) + (s ? " " + s : "");
        line += "\n" + theme.fg("dim", `  ⎿  ${details.activity ?? "thinking…"}`);
        return new Text(line, 0, 0);
      }

      // Background launched
      if (details.status === "background") {
        return new Text(theme.fg("dim", `  ⎿  Running in background (ID: ${details.agentId})`), 0, 0);
      }

      // Completed
      if (details.status === "completed") {
        const duration = formatMs(details.durationMs);
        const s = statsLine(details, theme);
        let line = theme.fg("success", "✓") + (s ? " " + s : "") + " " + theme.fg("dim", "·") + " " + theme.fg("dim", duration);

        if (expanded) {
          const resultText = result.content[0]?.type === "text" ? result.content[0].text : "";
          if (resultText) {
            const rLines = resultText.split("\n").slice(0, 50);
            for (const l of rLines) {
              line += "\n" + theme.fg("dim", `  ${l}`);
            }
          }
        } else {
          line += "\n" + theme.fg("dim", "  ⎿  Done");
        }
        return new Text(line, 0, 0);
      }

      // Error
      const s = statsLine(details, theme);
      let line = theme.fg("error", "✗") + (s ? " " + s : "");
      line += "\n" + theme.fg("error", `  ⎿  Error: ${details.error ?? "unknown"}`);
      return new Text(line, 0, 0);
    },

    // ---- Execute ----
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { session, forkedPath, historyCount } = await createCloneSession(ctx);

      // Save ui reference
      widgetUi = ctx.ui;

      // Shared tracking
      const startedAt = Date.now();
      let toolUses = 0;
      const activeTools = new Map<string, string>();
      let turnCount = 0;
      let cacheRead = 0;
      let cacheWrite = 0;
      let totalTokens = 0;

      const trackEvent = (event: any) => {
        if (event.type === "tool_execution_start") {
          const key = event.toolName + "_" + Date.now();
          activeTools.set(key, event.toolName);
        }
        if (event.type === "tool_execution_end") {
          for (const [key, name] of activeTools) {
            if (name === event.toolName) { activeTools.delete(key); break; }
          }
          toolUses++;
        }
        if (event.type === "message_end" && event.message.role === "assistant") {
          turnCount++;
          const u = event.message.usage;
          if (u) {
            cacheRead = u.cacheRead ?? 0;
            cacheWrite = u.cacheWrite ?? 0;
            totalTokens = u.totalTokens ?? 0;
          }
        }
      };

      // ========== Foreground ==========
      if (!params.mode || params.mode === "foreground") {
        let resultText = "";
        let spinnerFrame = 0;

        const emitUpdate = () => {
          const details: BranchDetails = {
            description: params.description,
            toolUses,
            turnCount,
            durationMs: Date.now() - startedAt,
            status: "running",
            activity: describeActivity(activeTools, resultText),
            spinnerFrame: spinnerFrame++ % SPINNER.length,
            cacheRead,
            cacheWrite,
            totalTokens,
          };
          onUpdate?.({
            content: [{ type: "text", text: `${toolUses} tool uses...` }],
            details: details as any,
          });
        };

        const spinnerTimer = setInterval(() => emitUpdate(), 80);

        const unsub = session.subscribe((event: any) => {
          trackEvent(event);
          if (event.type === "message_start") {
            resultText = "";
          }
          if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
            resultText += event.assistantMessageEvent.delta;
          }
          emitUpdate();
        });

        if (signal) {
          signal.addEventListener("abort", () => session.abort(), { once: true });
        }

        try {
          await session.prompt(`[Branch Agent] 你是从主会话 fork 出来的分支，直接执行以下任务，不要调用 BranchAgent 工具：\n\n${params.prompt}`);
        } finally {
          clearInterval(spinnerTimer);
          unsub();
        }

        resultText = resultText || collectResult(session, historyCount);
        session.dispose();

        // Tree integration disabled — see note at top of file
        if (forkedPath) {
          // attachToParentTree removed
        }

        const durationMs = Date.now() - startedAt;
        const cacheStr = totalTokens > 0
          ? `\n[Cache: ${cacheRead} read / ${cacheWrite} write / ${totalTokens} total = ${Math.round((cacheRead / totalTokens) * 100)}% hit]`
          : "";

        return textResult(resultText + cacheStr, {
          description: params.description,
          toolUses,
          turnCount,
          durationMs,
          status: "completed",
          cacheRead,
          cacheWrite,
          totalTokens,
        });
      }

      // ========== Background (with or without terminal) ==========
      if ((params.mode === "terminal") && forkedPath) {
        // Terminal mode: fork + spawn terminal with initialMessage
        // No in-process execution — the terminal's pi instance does the work.
        const sourceFile = ctx.sessionManager.getSessionFile();
        const termSM = SessionManager.forkFrom(sourceFile!, ctx.cwd);
        const termPath = termSM.getSessionFile();

        // Open terminal — pi receives prompt as initialMessage and auto-executes
        openTerminal(termPath!, params.description, params.prompt);

        return textResult(
          `Branch terminal opened.\nSession: ${termPath}\nDescription: ${params.description}\nUser can interact directly in the new terminal.`,
          {
            description: params.description,
            toolUses: 0,
            turnCount: 0,
            durationMs: 0,
            status: "background",
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            agentId: `terminal-${Date.now()}`,
          }
        );
      }

      // Pure background mode (no terminal)
      const id = genId();
      const record: AgentRecord = {
        id,
        description: params.description,
        session,
        status: "running",
        resultText: "",
        toolUses: 0,
        activeTools: new Map(),
        turnCount: 0,
        startedAt,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        forkedPath,
      };
      agents.set(id, record);

      ensureWidgetTimer();
      updateWidget();

      const run = async () => {
        let lastTurnText = "";
        const unsub = session.subscribe((event: any) => {
          if (event.type === "tool_execution_start") {
            const key = event.toolName + "_" + Date.now();
            record.activeTools.set(key, event.toolName);
          }
          if (event.type === "tool_execution_end") {
            for (const [key, name] of record.activeTools) {
              if (name === event.toolName) { record.activeTools.delete(key); break; }
            }
            record.toolUses++;
          }
          if (event.type === "message_end" && event.message.role === "assistant") {
            record.turnCount++;
            const u = event.message.usage;
            if (u) {
              record.cacheRead = u.cacheRead ?? 0;
              record.cacheWrite = u.cacheWrite ?? 0;
              record.totalTokens = u.totalTokens ?? 0;
            }
          }
          if (event.type === "message_start") {
            lastTurnText = "";
          }
          if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
            lastTurnText += event.assistantMessageEvent.delta;
            if (lastTurnText.trim()) record.resultText = lastTurnText;
          }
        });

        try {
          await session.prompt(`[Branch Agent] 你是从主会话 fork 出来的分支，直接执行以下任务，不要调用 BranchAgent 工具：\n\n${params.prompt}`);
          record.status = "done";
          record.resultText = record.resultText || collectResult(session, historyCount);
          record.completedAt = Date.now();
        } catch (e: any) {
          record.status = e?.message?.includes("abort") ? "aborted" : "error";
          record.error = e?.message;
          record.completedAt = Date.now();
        } finally {
          unsub();
          session.dispose();
          updateWidget();
        }

        // Auto-notify via sendMessage (CustomMessage, not user: role)
        // triggerTurn: true makes the model process the result automatically
        if (record.status === "done") {
          pi.sendMessage({
            customType: "branch-agent-result",
            content: record.resultText,
            display: true,
            details: {
              description: record.description,
              agentId: record.id,
              cacheRead: record.cacheRead,
              cacheWrite: record.cacheWrite,
              totalTokens: record.totalTokens,
              cachePercent: cachePercent(record),
              durationMs: record.completedAt ? record.completedAt - record.startedAt : 0,
            },
          }, { deliverAs: "followUp", triggerTurn: true });
        } else if (record.status === "error") {
          pi.sendMessage({
            customType: "branch-agent-result",
            content: `Error: ${record.error}`,
            display: true,
            details: {
              description: record.description,
              agentId: record.id,
              error: record.error,
            },
          }, { deliverAs: "followUp", triggerTurn: true });
        }
      };
      run();

      const terminalNote = params.mode === "terminal" && forkedPath
        ? `\nTerminal opened at: ${forkedPath}`
        : "";

      return textResult(
        `Branch agent started in background.\nID: ${id}\nDescription: ${params.description}\nContinue with your work. Result will be available when done.`,
        {
          description: params.description,
          toolUses: 0,
          turnCount: 0,
          durationMs: 0,
          status: "background",
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          agentId: id,
        }
      );
    },
  });

  // ---- get_branch_result ----
  pi.registerTool({
    name: "get_branch_result",
    label: "Get Branch Result",
    description:
      "Query the status and result of a previously launched background branch agent. Only call this if the user explicitly asks to check on a background task.",
    parameters: Type.Object({
      agent_id: Type.String({ description: "Agent ID to check" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const record = agents.get(params.agent_id);
      if (!record) {
        return textResult(`Agent ${params.agent_id} not found. It may have been cleaned up.`);
      }
      if (record.status === "running") {
        return textResult(`Agent "${record.description}" is still running. Wait for the auto-notification or try again later.`);
      }
      const durationMs = record.completedAt
        ? record.completedAt - record.startedAt
        : 0;
      const cacheStr = record.totalTokens > 0
        ? `\n[Cache: ${record.cacheRead} read / ${record.cacheWrite} write / ${record.totalTokens} total = ${cachePercent(record)}% hit]`
        : "";
      const statusLabel = record.status === "done" ? "✅ Completed" : record.status === "error" ? "❌ Error" : "⛔ Aborted";
      const errorStr = record.error ? `\nError: ${record.error}` : "";
      return textResult(
        `${statusLabel}: ${record.description}\n\n${record.resultText}${errorStr}${cacheStr}\nDuration: ${formatMs(durationMs)}`,
      );
    },
  });

  // ---- steer_branch ----
  pi.registerTool({
    name: "steer_branch",
    label: "Steer Branch",
    description:
      "Send a message to a running background branch agent to redirect its work.",
    parameters: Type.Object({
      agent_id: Type.String({ description: "Agent ID to steer" }),
      message: Type.String({ description: "Message to inject into agent conversation" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const record = agents.get(params.agent_id);
      if (!record) {
        return textResult(`Agent ${params.agent_id} not found.`);
      }
      if (record.status !== "running") {
        return textResult(`Agent "${record.description}" is ${record.status}, cannot steer.`);
      }
      await record.session.steer(params.message);
      return textResult(`Steering message sent to "${record.description}" (${params.agent_id}).`);
    },
  });
}
