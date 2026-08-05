import { StringEnum } from "@earendil-works/pi-ai";
import {
  createBashToolDefinition,
  formatSize,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type BashToolDetails,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { BoundedOutput, type BoundedOutputSnapshot } from "./bounded-output";
import type { ResolvedOptions } from "./config";
import {
  appendHints,
  renderCompletionMessage,
  renderProcessCall,
  renderProcessResult,
  resultText,
  sanitizedResult,
  stripModelOnlyLogLine,
  type CompletionRenderDetails,
} from "./render";
import {
  ProcessManager,
  type BackgroundBashDetails,
  type ManagedProcess,
  type ProcessOutcome,
} from "./process-manager";

export const BashInputSchema = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  name: Type.Optional(Type.String({ description: "Optional display name" })),
  background: Type.Optional(
    Type.Boolean({ description: "Start in the background and report completion automatically" }),
  ),
  timeout: Type.Optional(Type.Integer({ minimum: 1, description: "Timeout in whole seconds" })),
  timeoutAction: Type.Optional(
    StringEnum(["background", "kill"] as const, {
      description: "Keep running in the background or kill when the timeout expires",
    }),
  ),
});

export const BashProcessInputSchema = Type.Object({
  action: StringEnum(["list", "peek", "kill"] as const),
  pgid: Type.Optional(Type.Integer({ minimum: 1, description: "Process group ID" })),
});

export type BashInput = Static<typeof BashInputSchema>;
export type BashProcessInput = Static<typeof BashProcessInputSchema>;

type RawOutcome = { error?: undefined } | { error: Error };

const normalizeTimeout = (input: BashInput, options: ResolvedOptions): number =>
  Math.min(input.timeout ?? options.defaultTimeoutSeconds, options.maxTimeoutSeconds);

const renderBashCall = ({
  args,
  component,
  options,
  theme,
}: {
  args: BashInput;
  component: Component;
  options: ResolvedOptions;
  theme: Theme;
}): Component => {
  if (
    !(component instanceof Text) ||
    args.background ||
    args.timeout === undefined ||
    (args.timeoutAction ?? options.defaultTimeoutAction) !== "background"
  ) {
    return component;
  }

  const command = args.command || theme.fg("toolOutput", "...");
  const title = theme.fg("toolTitle", theme.bold(`$ ${command}`));
  const suffix = theme.fg("muted", ` (background after ${args.timeout}s)`);
  component.setText(`${title}${suffix}`);
  return component;
};

const OUTPUT_UPDATE_THROTTLE_MS = 100;

const addStableLog = (
  result: AgentToolResult<BashToolDetails | undefined>,
  managed: ManagedProcess,
): AgentToolResult<BackgroundBashDetails> => {
  const content = result.content[0];
  const raw = content?.type === "text" ? content.text : "";
  const text = raw.includes(managed.logPath)
    ? raw
    : `${raw.trimEnd()}${raw.trimEnd() ? "\n\n" : ""}Full output: ${managed.logPath}`;

  return {
    ...result,
    content: [{ type: "text", text }],
    details: {
      ...result.details,
      pgid: managed.pgid,
      fullOutputPath: managed.logPath,
    },
  };
};

const formatCapturedOutput = (
  snapshot: BoundedOutputSnapshot,
  logPath: string,
  emptyText = "(no output)",
): AgentToolResult<BashToolDetails | undefined> => {
  const truncation = snapshot.truncation;
  let text = snapshot.content || emptyText;
  const details = truncation.truncated ? { truncation, fullOutputPath: logPath } : undefined;
  if (!truncation.truncated) return { content: [{ type: "text", text }], details };

  const startLine = truncation.totalLines - truncation.outputLines + 1;
  const endLine = truncation.totalLines;
  if (truncation.lastLinePartial) {
    text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${formatSize(snapshot.lastLineBytes)}). Full output: ${logPath}]`;
  } else if (truncation.truncatedBy === "lines") {
    text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${logPath}]`;
  } else {
    text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(truncation.maxBytes)} limit). Full output: ${logPath}]`;
  }
  return { content: [{ type: "text", text }], details };
};

class ProcessOutput {
  private readonly output = new BoundedOutput();
  private managed: ManagedProcess | undefined;
  private updateTimer: NodeJS.Timeout | undefined;
  private updateDirty = false;
  private lastUpdateAt = 0;

  constructor(
    private readonly onUpdate:
      | AgentToolUpdateCallback<BackgroundBashDetails | undefined>
      | undefined,
  ) {}

  append = (data: Buffer): void => {
    this.output.append(data);
    this.scheduleUpdate();
  };

  attach = (managed: ManagedProcess): void => {
    this.managed = managed;
    this.emitUpdate();
  };

  finish = (): void => {
    this.output.finish();
    this.clearUpdateTimer();
    this.updateDirty = true;
    this.emitUpdate();
  };

  snapshot = (): BoundedOutputSnapshot => this.output.snapshot();

  private scheduleUpdate = (): void => {
    this.updateDirty = true;
    const delay = OUTPUT_UPDATE_THROTTLE_MS - (Date.now() - this.lastUpdateAt);
    if (delay <= 0) {
      this.clearUpdateTimer();
      this.emitUpdate();
      return;
    }
    if (this.updateTimer) return;
    this.updateTimer = setTimeout(() => {
      this.updateTimer = undefined;
      this.emitUpdate();
    }, delay);
  };

  private emitUpdate = (): void => {
    if (!this.updateDirty || !this.managed) return;
    this.updateDirty = false;
    this.lastUpdateAt = Date.now();
    const result = addStableLog(
      formatCapturedOutput(this.output.snapshot(), this.managed.logPath, ""),
      this.managed,
    );
    this.managed.latest = result;
    this.onUpdate?.(result);
  };

  private clearUpdateTimer = (): void => {
    if (!this.updateTimer) return;
    clearTimeout(this.updateTimer);
    this.updateTimer = undefined;
  };
}

const stableError = (error: Error, managed: ManagedProcess, output: string): Error => {
  const errorMessage = error.message.replace(/^\(no output\)\n\n/, "");
  const combined = [output.trimEnd(), errorMessage].filter(Boolean).join("\n\n");
  const terminalRequired =
    /(?:std(?:in|out) is not a terminal|not a tty|input device is not a tty|requires? (?:a )?(?:terminal|tty))/i.test(
      combined,
    );
  const display = terminalRequired
    ? `${combined.trimEnd()}\n\nHint: command may require a terminal (PTY unsupported).`
    : combined;
  const message = display.includes(managed.logPath)
    ? display
    : `${display.trimEnd()}\n\nFull output: ${managed.logPath}`;
  return new Error(message, { cause: error });
};

const settleCompletion = async ({
  rawOutcome,
  managed,
  output,
}: {
  rawOutcome: Promise<RawOutcome>;
  managed: ManagedProcess;
  output: ProcessOutput;
}): Promise<ProcessOutcome> => {
  const outcome = await rawOutcome;
  output.finish();
  const captured = formatCapturedOutput(
    output.snapshot(),
    managed.logPath,
    outcome.error ? "" : undefined,
  );

  if (outcome.error) {
    return { error: stableError(outcome.error, managed, resultText(captured)) };
  }

  const result = addStableLog(captured, managed);
  managed.latest = result;
  return { result };
};

const attachAbort = (
  signal: AbortSignal | undefined,
  controller: AbortController,
): (() => void) => {
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  return () => signal?.removeEventListener("abort", abort);
};

const executionEnvironment = (pi: ExtensionAPI, ctx: ExtensionContext): NodeJS.ProcessEnv => ({
  PI_SESSION_ID: ctx.sessionManager.getSessionId(),
  PI_SESSION_FILE: ctx.sessionManager.getSessionFile(),
  PI_PROVIDER: ctx.model?.provider,
  PI_MODEL: ctx.model?.id,
  PI_REASONING_LEVEL: pi.getThinkingLevel(),
});

const handoffResult = (
  managed: ManagedProcess,
  includeOutput: boolean,
): AgentToolResult<BackgroundBashDetails> => {
  const output = includeOutput
    ? stripModelOnlyLogLine(resultText(managed.latest), managed.logPath)
    : "";
  const summary = [
    `Started background process${managed.name ? `: ${managed.name}` : ""} · PGID ${managed.pgid}`,
    "Result will be reported automatically when it finishes.",
  ].join("\n");
  const text = [output, summary, `Full output: ${managed.logPath}`].filter(Boolean).join("\n\n");

  return {
    content: [{ type: "text", text }],
    details: {
      ...managed.latest?.details,
      pgid: managed.pgid,
      active: true,
      fullOutputPath: managed.logPath,
    },
  };
};

const completionContent = (
  managed: ManagedProcess,
  outcome: ProcessOutcome,
): { content: string; details: CompletionRenderDetails } => {
  const success = !outcome.error && managed.exitCode === 0;
  const elapsedMs = Date.now() - managed.startedAt;
  const output = stripModelOnlyLogLine(
    outcome.error?.message ?? resultText(outcome.result),
    managed.logPath,
  );
  const metadata = [
    success ? "Background bash finished" : "Background bash failed",
    `PGID ${managed.pgid}`,
    managed.name ? `Name: ${managed.name}` : undefined,
    `Command: ${managed.command}`,
    `Elapsed: ${(elapsedMs / 1000).toFixed(1)}s`,
    `Status: ${success ? "success" : "failed"}`,
    managed.exitCode === undefined ? undefined : `Exit code: ${managed.exitCode}`,
  ].filter((line) => line !== undefined);
  const logPath = output.includes(managed.logPath) ? undefined : `Full output: ${managed.logPath}`;
  const content = [metadata.join("\n"), output, logPath].filter(Boolean).join("\n\n");
  const truncated =
    Boolean(outcome.result?.details?.truncation?.truncated) || output.includes("[Showing ");

  return {
    content,
    details: {
      status: success ? "success" : "failed",
      pgid: managed.pgid,
      name: managed.name,
      command: managed.command,
      elapsedMs,
      exitCode: managed.exitCode,
      logPath: managed.logPath,
      truncated,
    },
  };
};

const notifyCompletion = (
  pi: ExtensionAPI,
  managed: ManagedProcess,
  outcome: ProcessOutcome,
): void => {
  const message = completionContent(managed, outcome);
  pi.sendMessage(
    {
      customType: "background-bash-completion",
      content: message.content,
      display: true,
      details: message.details,
    },
    { triggerTurn: true, deliverAs: "followUp" },
  );
};

const completionBeforeTimeout = (
  completion: Promise<ProcessOutcome>,
  seconds: number,
): Promise<ProcessOutcome | undefined> =>
  new Promise((resolveRace) => {
    const timer = setTimeout(() => resolveRace(undefined), seconds * 1000);
    void completion.then((outcome) => {
      clearTimeout(timer);
      resolveRace(outcome);
    });
  });

const runBash = async ({
  toolCallId,
  pi,
  ctx,
  input,
  signal,
  onUpdate,
  manager,
  options,
}: {
  toolCallId: string;
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  input: BashInput;
  signal: AbortSignal | undefined;
  onUpdate: AgentToolUpdateCallback<BackgroundBashDetails | undefined> | undefined;
  manager: ProcessManager;
  options: ResolvedOptions;
}): Promise<AgentToolResult<BackgroundBashDetails | undefined>> => {
  const controller = new AbortController();
  const detachAbort = attachAbort(signal, controller);
  const timeout = normalizeTimeout(input, options);
  const timeoutAction = input.timeoutAction ?? options.defaultTimeoutAction;
  let managed: ManagedProcess | undefined;
  let forwardUpdates = true;
  const output = new ProcessOutput((update) => {
    if (forwardUpdates) onUpdate?.(update);
  });
  const prepared = manager.prepare({
    command: input.command,
    name: input.name,
    controller,
    env: executionEnvironment(pi, ctx),
    onData: output.append,
    detachAbort,
  });
  const base = createBashToolDefinition(ctx.cwd, {
    operations: prepared.operations,
    commandPrefix: manager.getCommandPrefix(),
  });
  // ProcessOutput owns streamed output so Pi's accumulator never creates a second log.
  const rawOutcome: Promise<RawOutcome> = base
    .execute(
      toolCallId,
      {
        command: input.command,
        timeout: input.background || timeoutAction === "background" ? undefined : timeout,
      },
      controller.signal,
      undefined,
      ctx,
    )
    .then(
      () => ({}),
      (error) => ({ error: error instanceof Error ? error : new Error(String(error)) }),
    );
  onUpdate?.({ content: [], details: undefined });
  managed = await prepared.spawned;
  output.attach(managed);
  managed.completion = settleCompletion({ rawOutcome, managed, output });

  if (input.background) {
    forwardUpdates = false;
    manager.handoff(managed, (process, outcome) => notifyCompletion(pi, process, outcome));
    return handoffResult(managed, false);
  }

  if (timeoutAction === "background") {
    const outcome = await completionBeforeTimeout(managed.completion, timeout);
    if (!outcome) {
      forwardUpdates = false;
      manager.handoff(managed, (process, outcome) => notifyCompletion(pi, process, outcome));
      return handoffResult(managed, true);
    }
    manager.finishForeground(managed);
    if (outcome.error) throw outcome.error;
    return outcome.result;
  }

  const outcome = await managed.completion;
  manager.finishForeground(managed);
  if (outcome.error) throw outcome.error;
  return outcome.result;
};

const requirePgid = (input: BashProcessInput): number => {
  if (input.pgid === undefined) throw new Error(`bash_process ${input.action} requires a PGID`);
  return input.pgid;
};

const listProcesses = (
  manager: ProcessManager,
): AgentToolResult<BackgroundBashDetails | undefined> => {
  const active = [...manager.processes.values()].filter((managed) => managed.notifyOnExit);
  if (active.length === 0) {
    return {
      content: [{ type: "text", text: "No active background processes." }],
      details: undefined,
    };
  }

  const now = Date.now();
  const text = active
    .map((managed) =>
      [
        `PGID ${managed.pgid}`,
        managed.name ? `Name: ${managed.name}` : undefined,
        `Command: ${managed.command}`,
        `Elapsed: ${((now - managed.startedAt) / 1000).toFixed(1)}s`,
      ]
        .filter((line) => line !== undefined)
        .join("\n"),
    )
    .join("\n\n");
  return { content: [{ type: "text", text }], details: undefined };
};

const inspectProcess = (
  managed: ManagedProcess,
): AgentToolResult<BackgroundBashDetails | undefined> => {
  const output = stripModelOnlyLogLine(resultText(managed.latest), managed.logPath);
  const text = `${output || "(no output yet)"}\n\nFull output: ${managed.logPath}`;
  return {
    content: [{ type: "text", text }],
    details: {
      ...managed.latest?.details,
      pgid: managed.pgid,
      active: true,
      fullOutputPath: managed.logPath,
    },
  };
};

const killedResult = (
  managed: ManagedProcess,
  outcome: ProcessOutcome,
): AgentToolResult<BackgroundBashDetails | undefined> => {
  const output = stripModelOnlyLogLine(
    outcome.error?.message ?? resultText(outcome.result),
    managed.logPath,
  );
  return {
    content: [
      {
        type: "text",
        text: [
          `Killed background process · PGID ${managed.pgid}.`,
          output,
          `Full output: ${managed.logPath}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ],
    details: {
      ...outcome.result?.details,
      pgid: managed.pgid,
      fullOutputPath: managed.logPath,
    },
  };
};

export const registerTools = (
  pi: ExtensionAPI,
  manager: ProcessManager,
  options: ResolvedOptions,
): void => {
  const builtInRenderer = createBashToolDefinition(process.cwd());
  pi.registerTool({
    name: options.bashToolName,
    label: options.bashToolName,
    description: options.bashToolDescription,
    promptSnippet:
      options.systemPrompt && options.bashSystemPromptSnippet !== false
        ? options.bashSystemPromptSnippet
        : undefined,
    promptGuidelines: options.systemPrompt ? options.systemPromptGuidelines : [],
    parameters: BashInputSchema,
    execute: (toolCallId, input, signal, onUpdate, ctx) =>
      runBash({ toolCallId, pi, ctx, input, signal, onUpdate, manager, options }),
    renderCall(args, theme, context) {
      const component = builtInRenderer.renderCall!(args, theme, context);
      return renderBashCall({ args, component, options, theme });
    },
    renderResult(result, renderOptions, theme, context) {
      const typedResult = result as AgentToolResult<BackgroundBashDetails | undefined>;
      const display = sanitizedResult(typedResult);
      const component = builtInRenderer.renderResult!(
        display.result,
        renderOptions,
        theme,
        context,
      );
      return appendHints(component, typedResult, theme);
    },
  });

  pi.registerTool({
    name: options.processToolName,
    label: options.processToolName,
    description: options.processToolDescription,
    promptSnippet:
      options.systemPrompt && options.processSystemPromptSnippet !== false
        ? options.processSystemPromptSnippet
        : undefined,
    promptGuidelines: options.systemPrompt ? options.systemPromptGuidelines : [],
    parameters: BashProcessInputSchema,
    async execute(_toolCallId, input) {
      if (input.action === "list") return listProcesses(manager);
      const pgid = requirePgid(input);
      if (input.action === "peek") {
        const managed = manager.processes.get(pgid);
        if (!managed?.notifyOnExit) {
          throw new Error(`No active background process with PGID ${pgid}`);
        }
        return inspectProcess(managed);
      }
      const stopped = await manager.kill(pgid);
      return killedResult(stopped.managed, stopped.outcome);
    },
    renderCall(args, theme) {
      return renderProcessCall(args, options.processToolName, theme);
    },
    renderResult(result, renderOptions, theme) {
      return renderProcessResult(
        result as AgentToolResult<BackgroundBashDetails | undefined>,
        renderOptions,
        theme,
      );
    },
  });
};

export const registerCompletionRenderer = (pi: ExtensionAPI): void => {
  pi.registerMessageRenderer<CompletionRenderDetails>(
    "background-bash-completion",
    (message, renderOptions, theme) => {
      if (!message.details) throw new Error("Missing background bash completion details");
      const content = typeof message.content === "string" ? message.content : "";
      return renderCompletionMessage(content, message.details, renderOptions, theme);
    },
  );
};
