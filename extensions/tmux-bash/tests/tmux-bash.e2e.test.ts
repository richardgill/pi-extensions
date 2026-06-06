import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it, onTestFinished } from "vitest";
import { DEFAULT_OPTIONS } from "../src/config";
import { formatDurationSeconds } from "../src/render";
import {
  backgroundSessionName,
  getWindows,
  sessionExists,
  tmuxWindowAttachCommand,
} from "../src/tmux-utils";
import {
  createPiE2eWorkspace,
  expectPiSuccess,
  type PiE2eWorkspace,
} from "./testing/pi-test-utils";
import {
  bash,
  recordLatestToolResult,
  recordSystemPrompt,
  scriptedText,
  scriptedToolCall,
  scriptedToolCallWithLatestWindowId,
  type ScriptedStep,
} from "./testing/scripted-provider";

type ExpectedModelText =
  | string
  | ((workspace: PiE2eWorkspace, outputFile: string | undefined) => string);

type ExpectedModelTextPart = string | ((workspace: PiE2eWorkspace) => string);

type TmuxBashE2eTestCase = {
  name: string;
  tmuxBashConfig?: Record<string, unknown>;
  steps: ScriptedStep[];
  captureTool?: string;
  expectedModelText?: ExpectedModelText;
  expectedModelTextIncludes?: ExpectedModelTextPart[];
  expectedOutputFileContent?: string;
  expectedLatestToolResult?: { toolName: string; isError: boolean };
  expectedTmuxSessionExists?: boolean;
  timeoutMs?: number;
};

const createWorkspace = (tmuxBashConfig: Record<string, unknown> = {}): PiE2eWorkspace => {
  const workspace = createPiE2eWorkspace({ tmuxBashConfig });
  onTestFinished(() => workspace.cleanup());
  return workspace;
};

const backgroundStartContext = (workspace: PiE2eWorkspace): string => {
  const window = getWindows(workspace.tmuxSession()).at(0);
  const attachCommand = tmuxWindowAttachCommand(window?.id ?? "", process.env, "tmux");

  return [
    `Started in background tmux window: ${window?.title} ${window?.id}.`,
    "Result will be reported when it finishes.",
    "",
    `Attach with: ${attachCommand}`,
  ].join("\n");
};

const peekContextOutput = (workspace: PiE2eWorkspace): string => {
  const window = getWindows(workspace.tmuxSession()).find((item) => item.title === "peek-test");
  return `tmux window: peek-test ${window?.id}\n$ printf 'peek-me\\n'; sleep 30\npeek-me`;
};

const compactPeekContextOutput = (workspace: PiE2eWorkspace): string => {
  const window = getWindows(workspace.tmuxSession()).find((item) => item.title === "peek-compact");
  return [
    `tmux window: peek-compact ${window?.id}`,
    `$ for i in $(seq 1 8); do printf 'peek-compact-%s\\n' "$i"; done; sleep 30`,
    "... (3 earlier lines omitted)",
    "peek-compact-4",
    "peek-compact-5",
    "peek-compact-6",
    "peek-compact-7",
    "peek-compact-8",
  ].join("\n");
};

const contextPath = (workspace: PiE2eWorkspace, name: string): string =>
  workspace.contextOutputPath(name);

const firstUpdateMatching = (
  updates: { text: string; elapsedMs: number }[],
  pattern: RegExp,
): { text: string; elapsedMs: number } | undefined =>
  updates.find((update) => pattern.test(update.text));

type CaptureLatestToolResultOptions = {
  outputName: string;
  toolName: string;
  assistantReply: string;
};

const captureLatestToolResult = (
  workspace: PiE2eWorkspace,
  options: CaptureLatestToolResultOptions,
): ScriptedStep =>
  recordLatestToolResult(workspace.contextOutputPath(options.outputName), {
    toolName: options.toolName,
    text: options.assistantReply,
  });

const captureName = (testName: string): string =>
  testName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const scriptForTestCase = (
  workspace: PiE2eWorkspace,
  testCase: TmuxBashE2eTestCase,
): ScriptedStep[] => {
  if (
    testCase.expectedModelText === undefined &&
    testCase.expectedModelTextIncludes === undefined
  ) {
    return testCase.steps;
  }

  return [
    ...testCase.steps,
    captureLatestToolResult(workspace, {
      outputName: captureName(testCase.name),
      toolName: testCase.captureTool ?? "bash",
      assistantReply: "ok",
    }),
  ];
};

const resolveExpectedModelText = (
  expected: ExpectedModelText,
  workspace: PiE2eWorkspace,
  outputFile: string | undefined,
): string => {
  if (typeof expected === "string") {
    return expected;
  }

  return expected(workspace, outputFile);
};

const resolveExpectedModelTextPart = (
  expected: ExpectedModelTextPart,
  workspace: PiE2eWorkspace,
): string => {
  if (typeof expected === "string") {
    return expected;
  }

  return expected(workspace);
};

type PreexistingTmuxWindowOptions = {
  title: string;
  gitRoot?: string;
  piSessionId?: string;
};

const createPreexistingTmuxWindow = (
  workspace: PiE2eWorkspace,
  options: PreexistingTmuxWindowOptions,
): string => {
  const session = workspace.tmuxSession();
  const args = sessionExists(session)
    ? [
        "new-window",
        "-d",
        "-t",
        session,
        "-n",
        options.title,
        "-P",
        "-F",
        "#{window_id}",
        "sleep 30",
      ]
    : [
        "new-session",
        "-d",
        "-s",
        session,
        "-n",
        options.title,
        "-P",
        "-F",
        "#{window_id}",
        "sleep 30",
      ];
  const windowId = execFileSync("tmux", args, { encoding: "utf8" }).trim();

  if (options.gitRoot !== undefined) {
    execFileSync("tmux", [
      "set-window-option",
      "-q",
      "-t",
      windowId,
      "@pi-tmux-bash-git-root",
      options.gitRoot,
    ]);
  }
  if (options.piSessionId !== undefined) {
    execFileSync("tmux", [
      "set-window-option",
      "-q",
      "-t",
      windowId,
      "@pi-tmux-bash-pi-session-id",
      options.piSessionId,
    ]);
  }

  return windowId;
};

const windowTitles = (workspace: PiE2eWorkspace): string[] =>
  getWindows(workspace.tmuxSession())
    .map((window) => window.title)
    .sort();

const findOutputFileWithContent = (workspace: PiE2eWorkspace, content: string): string => {
  const match = workspace.outputFiles().find((file) => readFileSync(file, "utf8") === content);
  expect(match, `Output files: ${workspace.outputFiles().join(", ")}`).toBeDefined();
  return match!;
};

type TmuxBashE2eRun = {
  workspace: PiE2eWorkspace;
  result: Awaited<ReturnType<PiE2eWorkspace["run"]>>;
};

const capturesModelText = (testCase: TmuxBashE2eTestCase): boolean =>
  testCase.expectedModelText !== undefined || testCase.expectedModelTextIncludes !== undefined;

const expectedOutputFileFor = (
  workspace: PiE2eWorkspace,
  testCase: TmuxBashE2eTestCase,
): string | undefined => {
  if (testCase.expectedOutputFileContent === undefined) return undefined;

  return findOutputFileWithContent(workspace, testCase.expectedOutputFileContent);
};

const capturedModelTextFor = (
  workspace: PiE2eWorkspace,
  testCase: TmuxBashE2eTestCase,
): string | undefined => {
  if (!capturesModelText(testCase)) return undefined;

  return workspace.readContextOutput(captureName(testCase.name));
};

const runTestCase = async (testCase: TmuxBashE2eTestCase): Promise<TmuxBashE2eRun> => {
  const workspace = createWorkspace(testCase.tmuxBashConfig);
  const result = await workspace.run({
    script: scriptForTestCase(workspace, testCase),
    prompt: testCase.name,
    timeoutMs: testCase.timeoutMs,
  });

  return { workspace, result };
};

const expectTmuxSessionState = (workspace: PiE2eWorkspace, testCase: TmuxBashE2eTestCase): void => {
  if (testCase.expectedTmuxSessionExists === undefined) return;

  expect(workspace.tmuxSessionExists()).toBe(testCase.expectedTmuxSessionExists);
};

const expectExactModelText = (
  workspace: PiE2eWorkspace,
  testCase: TmuxBashE2eTestCase,
  modelText: string | undefined,
  outputFile: string | undefined,
): void => {
  if (testCase.expectedModelText === undefined) return;

  expect(modelText).toBe(
    resolveExpectedModelText(testCase.expectedModelText, workspace, outputFile),
  );
};

const expectModelTextParts = (
  workspace: PiE2eWorkspace,
  testCase: TmuxBashE2eTestCase,
  modelText: string | undefined,
): void => {
  testCase.expectedModelTextIncludes?.forEach((expected) => {
    expect(modelText).toContain(resolveExpectedModelTextPart(expected, workspace));
  });
};

const expectLatestToolResult = (workspace: PiE2eWorkspace, testCase: TmuxBashE2eTestCase): void => {
  if (testCase.expectedLatestToolResult === undefined) return;

  const expected = testCase.expectedLatestToolResult;
  expect(workspace.latestToolResult(expected.toolName)?.isError).toBe(expected.isError);
};

const expectTestCase = (testCase: TmuxBashE2eTestCase, run: TmuxBashE2eRun): void => {
  expectPiSuccess(run.result);
  expectTmuxSessionState(run.workspace, testCase);

  const outputFile = expectedOutputFileFor(run.workspace, testCase);
  const modelText = capturedModelTextFor(run.workspace, testCase);

  expectExactModelText(run.workspace, testCase, modelText, outputFile);
  expectModelTextParts(run.workspace, testCase, modelText);
  expectLatestToolResult(run.workspace, testCase);
};

const foregroundCommandCases: TmuxBashE2eTestCase[] = [
  {
    name: "prints stdout exactly",
    steps: [bash("printf 'hello\\n'")],
    expectedModelText: "hello",
    expectedOutputFileContent: "hello\n",
    expectedLatestToolResult: { toolName: "bash", isError: false },
    expectedTmuxSessionExists: false,
  },
  {
    name: "captures stderr exactly",
    steps: [bash("printf 'oops\\n' >&2")],
    expectedModelText: "oops",
    expectedOutputFileContent: "oops\n",
    expectedTmuxSessionExists: false,
  },
  {
    name: "captures delayed foreground stdout exactly",
    steps: [bash('echo "hello" && sleep 5 && echo "bye"', { timeout: 10 })],
    expectedModelText: "hello\nbye",
    expectedOutputFileContent: "hello\nbye\n",
    expectedTmuxSessionExists: false,
    timeoutMs: 20_000,
  },
  {
    name: "reports non-zero exit codes",
    steps: [bash("printf 'bad\\n'; exit 7")],
    expectedModelText: "bad\n\nCommand exited with code 7",
    expectedOutputFileContent: "bad\n",
    expectedLatestToolResult: { toolName: "bash", isError: true },
    expectedTmuxSessionExists: false,
  },
  {
    name: "kills timed-out foreground command",
    steps: [
      bash("printf 'starting\\n'; sleep 5", {
        timeout: 1,
        timeoutAction: "kill",
      }),
    ],
    expectedModelText: "starting\n\nCommand timed out after 1 seconds",
    expectedOutputFileContent: "starting\n",
    expectedLatestToolResult: { toolName: "bash", isError: true },
    expectedTmuxSessionExists: false,
  },
];

const backgroundCommandCases: TmuxBashE2eTestCase[] = [
  {
    name: "background command renders start output",
    steps: [bash("sleep 90", { background: true })],
    expectedModelText: backgroundStartContext,
  },
  {
    name: "background command returns immediately and leaves session running",
    steps: [
      bash("sleep 30", { background: true, name: "server" }),
      scriptedToolCall("tmux", { action: "list" }, { delayMs: 500 }),
    ],
    captureTool: "tmux",
    expectedModelTextIncludes: ["Background session", "1 window(s)", "server"],
    expectedTmuxSessionExists: true,
  },
  {
    name: "lists background tmux windows",
    steps: [
      bash("sleep 30", { background: true, name: "worker" }),
      scriptedToolCall("tmux", { action: "list" }, { delayMs: 500 }),
    ],
    captureTool: "tmux",
    expectedModelTextIncludes: ["Background session", "1 window(s)", "worker"],
    expectedTmuxSessionExists: true,
  },
  {
    name: "peeks background tmux output",
    steps: [
      bash("printf 'peek-me\\n'; sleep 30", {
        background: true,
        name: "peek-test",
      }),
      scriptedToolCallWithLatestWindowId("tmux", { action: "peek" }, { delayMs: 500 }),
    ],
    captureTool: "tmux",
    expectedModelText: peekContextOutput,
    expectedOutputFileContent: "peek-me\n",
    expectedTmuxSessionExists: true,
  },
  {
    name: "peeks background tmux output compactly",
    steps: [
      bash("for i in $(seq 1 8); do printf 'peek-compact-%s\\n' \"$i\"; done; sleep 30", {
        background: true,
        name: "peek-compact",
      }),
      scriptedToolCallWithLatestWindowId("tmux", { action: "peek" }, { delayMs: 500 }),
    ],
    captureTool: "tmux",
    expectedModelText: compactPeekContextOutput,
    expectedOutputFileContent:
      "peek-compact-1\npeek-compact-2\npeek-compact-3\npeek-compact-4\npeek-compact-5\npeek-compact-6\npeek-compact-7\npeek-compact-8\n",
    expectedTmuxSessionExists: true,
  },
];

const contextLimitCases: TmuxBashE2eTestCase[] = [
  {
    name: "truncates bash context output but preserves full output file",
    tmuxBashConfig: { bashContextLines: 3 },
    steps: [bash("printf 'line-1\\nline-2\\nline-3\\nline-4\\nline-5\\n'")],
    expectedModelText: (_workspace, outputFile) =>
      `line-3\nline-4\nline-5\n\n[Showing lines 3-5 of 5. Full output: ${outputFile}]`,
    expectedOutputFileContent: "line-1\nline-2\nline-3\nline-4\nline-5\n",
    expectedTmuxSessionExists: false,
  },
];

const testCases = [...foregroundCommandCases, ...backgroundCommandCases, ...contextLimitCases];

describe("tmux-bash e2e", () => {
  it("formats foreground bash duration without trailing decimal", () => {
    expect(formatDurationSeconds(5_000)).toBe("5s");
    expect(formatDurationSeconds(10_000)).toBe("10s");
  });

  it("applies system prompt configuration", async () => {
    const workspace = createWorkspace({
      tmuxToolName: "mux",
      bashSystemPromptSnippet:
        "CUSTOM bash {{defaultTimeoutSeconds}}/{{maxTimeoutSeconds}}/{{maxOutputKb}}",
      tmuxSystemPromptSnippet: false,
      systemPromptGuidelines: ["Use {{tmuxToolName}} with {{attachCommand}} and @123."],
    });
    const outputPath = contextPath(workspace, "system-prompt");

    const result = await workspace.run({ script: [recordSystemPrompt(outputPath, "ok")] });

    expectPiSuccess(result);
    const prompt = readFileSync(outputPath, "utf8");
    expect(prompt).toContain("- bash: CUSTOM bash 30/60/50");
    expect(prompt).not.toContain("- mux: Inspect and control");
    expect(prompt).toContain("- Use mux with tmux");
    expect(prompt).toContain("@123");
  });

  it("streams foreground stdout before command completion", async () => {
    const workspace = createWorkspace();
    const result = await workspace.runBashTool({
      command: 'echo "hello" && sleep 5 && echo "bye"',
      timeout: 10,
      timeoutAction: "background",
      background: false,
      pollInterval: 0,
      pollLines: 30,
    });

    const helloUpdate = firstUpdateMatching(result.updates, /(^|\n)hello(\n|$)/);

    expect(helloUpdate?.elapsedMs).toBeLessThan(5_000);
    expect(helloUpdate?.text).toMatch(/(^|\n)hello(\n|$)/);
    expect(helloUpdate?.text).not.toMatch(/(^|\n)bye(\n|$)/);
    expect(result.text).toMatch(/^hello\nbye/);
  }, 30_000);

  it("does not trigger assistant turns for background poll messages", async () => {
    const workspace = createWorkspace({ pollDelivery: "display" });
    const result = await workspace.runBashTool(
      {
        command: "printf 'line-1\\nline-2\\nline-3\\nline-4\\n'; sleep 5",
        timeout: 10,
        timeoutAction: "background",
        background: true,
        pollInterval: 1,
        pollLines: 2,
      },
      { waitAfterExecuteMs: 1_200 },
    );

    const pollMessage = result.messages.find((message) => message.customType === "tmux-bash-poll");

    expect(pollMessage?.content).toMatch(/^tmux poll: .* @\d+/);
    expect(pollMessage?.content).toContain("Attach with: tmux");
    expect(pollMessage?.content).not.toContain("(:");
    expect(pollMessage?.content).toContain(
      "$ printf 'line-1\\nline-2\\nline-3\\nline-4\\n'; sleep 5",
    );
    expect(pollMessage?.content).toContain("line-1");
    expect(pollMessage?.content).toContain("line-2");
    expect(pollMessage?.content).toContain("line-3");
    expect(pollMessage?.content).toContain("line-4");
    expect(pollMessage?.triggerTurn).toBe(false);
    expect(pollMessage?.deliverAs).toBeUndefined();
  }, 20_000);

  it("does not resend unchanged background poll output", async () => {
    const workspace = createWorkspace({ pollDelivery: "display" });
    const result = await workspace.runBashTool(
      {
        command: "printf 'same\\n'; sleep 5",
        timeout: 10,
        timeoutAction: "background",
        background: true,
        pollInterval: 1,
        pollLines: 5,
      },
      { waitAfterExecuteMs: 2_200 },
    );

    const pollMessages = result.messages.filter(
      (message) => message.customType === "tmux-bash-poll",
    );

    expect(pollMessages).toHaveLength(1);
  }, 20_000);

  it("resends unchanged model-delivered background poll output", async () => {
    const workspace = createWorkspace({ minimumPollIntervalSeconds: 1 });
    const result = await workspace.runBashTool(
      {
        command: "printf 'same-model\\n'; sleep 5",
        timeout: 10,
        timeoutAction: "background",
        background: true,
        pollInterval: 1,
        pollLines: 5,
      },
      { waitAfterExecuteMs: 2_200 },
    );

    const pollMessages = result.messages.filter(
      (message) => message.customType === "tmux-bash-poll",
    );

    expect(pollMessages.length).toBeGreaterThanOrEqual(2);
    expect(pollMessages.every((message) => message.triggerTurn === true)).toBe(true);
    expect(pollMessages.every((message) => message.deliverAs === "followUp")).toBe(true);
  }, 20_000);

  it("uses global tmux session scope by default", async () => {
    const workspace = createWorkspace();

    const result = await workspace.run({
      script: [bash("sleep 30", { background: true, name: "default-global" }), scriptedText("ok")],
      prompt: "default global session",
    });

    expectPiSuccess(result);
    expect(workspace.tmuxSession()).not.toBe(
      backgroundSessionName(workspace.projectDir, DEFAULT_OPTIONS.gitRootTmuxSessionNameTemplate),
    );
    expect(windowTitles(workspace)).toContain("default-global");
  }, 20_000);

  it("uses git-root tmux session scope when configured", async () => {
    const workspace = createWorkspace({ tmuxSessionScope: "git-root" });

    const result = await workspace.run({
      script: [
        bash("sleep 30", { background: true, name: "git-root-session" }),
        scriptedText("ok"),
      ],
      prompt: "git root session",
    });

    expectPiSuccess(result);
    expect(workspace.tmuxSession()).toBe(
      backgroundSessionName(workspace.projectDir, DEFAULT_OPTIONS.gitRootTmuxSessionNameTemplate),
    );
    expect(windowTitles(workspace)).toContain("git-root-session");
  }, 20_000);

  it("honors custom global tmux session names", async () => {
    const customGlobalSession = `pi-tmux-bash-custom-global-${process.pid}`;
    const workspace = createWorkspace({ globalTmuxSessionName: customGlobalSession });

    const result = await workspace.run({
      script: [
        bash("sleep 30", { background: true, name: "custom-global" }),
        scriptedToolCall("tmux", { action: "list" }, { delayMs: 500 }),
        captureLatestToolResult(workspace, {
          outputName: "custom-global-list",
          toolName: "tmux",
          assistantReply: "listed",
        }),
      ],
      prompt: "custom global session",
    });

    expectPiSuccess(result);
    expect(workspace.tmuxSession()).toBe(customGlobalSession);
    expect(workspace.readContextOutput("custom-global-list")).toContain(
      `Background session ${customGlobalSession}`,
    );
    expect(workspace.readContextOutput("custom-global-list")).toContain("custom-global");
  }, 20_000);

  it("honors custom git-root tmux session name templates", async () => {
    const workspace = createWorkspace({
      tmuxSessionScope: "git-root",
      gitRootTmuxSessionNameTemplate: "custom-{{gitRootSessionName}}",
    });

    const result = await workspace.run({
      script: [bash("sleep 30", { background: true, name: "custom-git-root" }), scriptedText("ok")],
      prompt: "custom git root session",
    });

    expectPiSuccess(result);
    expect(workspace.tmuxSession()).toBe(
      backgroundSessionName(workspace.projectDir, "custom-{{gitRootSessionName}}"),
    );
    expect(windowTitles(workspace)).toContain("custom-git-root");
  }, 20_000);

  it("honors configured window name templates", async () => {
    const workspace = createWorkspace({ tmuxWindowNameTemplate: "bg-{{nameOrCommand}}" });

    const result = await workspace.run({
      script: [
        bash("sleep 30", { background: true, name: "named" }),
        scriptedToolCall("tmux", { action: "list" }, { delayMs: 500 }),
        captureLatestToolResult(workspace, {
          outputName: "custom-window-name-list",
          toolName: "tmux",
          assistantReply: "listed",
        }),
      ],
      prompt: "custom window name",
    });

    expectPiSuccess(result);
    expect(workspace.readContextOutput("custom-window-name-list")).toContain("bg-named");
  }, 20_000);

  it("defaults tmux window scope to the current pi session", async () => {
    const workspace = createWorkspace();
    createPreexistingTmuxWindow(workspace, {
      title: "foreign",
      gitRoot: workspace.projectDir,
      piSessionId: "foreign-session",
    });

    const result = await workspace.run({
      script: [
        bash("sleep 30", { background: true, name: "own" }),
        scriptedToolCall("tmux", { action: "list" }, { delayMs: 500 }),
        captureLatestToolResult(workspace, {
          outputName: "default-window-scope-list",
          toolName: "tmux",
          assistantReply: "listed",
        }),
      ],
      prompt: "default pi-session window scope",
    });

    expectPiSuccess(result);
    expect(workspace.readContextOutput("default-window-scope-list")).toContain("own");
    expect(workspace.readContextOutput("default-window-scope-list")).not.toContain("foreign");
  }, 20_000);

  it("kills a scoped background tmux window by window id", async () => {
    const workspace = createWorkspace({ tmuxWindowScope: "all" });
    const startResult = await workspace.run({
      script: [bash("sleep 30", { background: true, name: "kill-id" }), scriptedText("started")],
      prompt: "start kill window",
    });
    const windowId = getWindows(workspace.tmuxSession()).find(
      (window) => window.title === "kill-id",
    )?.id;
    if (!windowId) throw new Error("Expected kill-id window to exist");

    const result = await workspace.run({
      script: [
        scriptedToolCall("tmux", { action: "kill", window: windowId }, { delayMs: 500 }),
        captureLatestToolResult(workspace, {
          outputName: "kill-window-id",
          toolName: "tmux",
          assistantReply: "killed",
        }),
      ],
      prompt: "kill window id",
    });

    expectPiSuccess(startResult);
    expectPiSuccess(result);
    expect(workspace.readContextOutput("kill-window-id")).toBe(
      `Killed background tmux window: kill-id ${windowId}.`,
    );
    expect(windowTitles(workspace)).toEqual([]);
  }, 20_000);

  it("does not kill windows outside the current scope", async () => {
    const workspace = createWorkspace();
    const windowId = createPreexistingTmuxWindow(workspace, {
      title: "foreign",
      gitRoot: workspace.projectDir,
      piSessionId: "foreign-session",
    });

    const result = await workspace.run({
      script: [
        scriptedToolCall("tmux", { action: "kill", window: windowId }, { delayMs: 500 }),
        captureLatestToolResult(workspace, {
          outputName: "default-window-scope-kill",
          toolName: "tmux",
          assistantReply: "not-killed",
        }),
      ],
      prompt: "default pi-session window kill scope",
    });

    expectPiSuccess(result);
    expect(workspace.readContextOutput("default-window-scope-kill")).toBe(
      `No bash-created tmux window ${windowId} in session ${workspace.tmuxSession()}.`,
    );
    expect(windowTitles(workspace)).toEqual(["foreign"]);
  }, 20_000);

  it("can scope global tmux windows by git root", async () => {
    const workspace = createWorkspace({ tmuxWindowScope: "git-root" });
    createPreexistingTmuxWindow(workspace, {
      title: "foreign-same-git-root",
      gitRoot: workspace.projectDir,
      piSessionId: "foreign-session",
    });

    const result = await workspace.run({
      script: [
        bash("sleep 30", { background: true, name: "own-git-root" }),
        scriptedToolCall("tmux", { action: "list" }, { delayMs: 500 }),
        captureLatestToolResult(workspace, {
          outputName: "git-root-window-scope-list",
          toolName: "tmux",
          assistantReply: "listed",
        }),
      ],
      prompt: "git root window scope",
    });

    expectPiSuccess(result);
    expect(workspace.readContextOutput("git-root-window-scope-list")).toContain("own-git-root");
    expect(workspace.readContextOutput("git-root-window-scope-list")).not.toContain(
      "foreign-same-git-root",
    );
  }, 20_000);

  it("can scope global tmux windows to all windows", async () => {
    const workspace = createWorkspace({ tmuxWindowScope: "all" });
    createPreexistingTmuxWindow(workspace, { title: "untagged" });

    const result = await workspace.run({
      script: [
        bash("sleep 30", { background: true, name: "own-all" }),
        scriptedToolCall("tmux", { action: "list" }, { delayMs: 500 }),
        captureLatestToolResult(workspace, {
          outputName: "all-window-scope-list",
          toolName: "tmux",
          assistantReply: "listed",
        }),
      ],
      prompt: "all window scope",
    });

    expectPiSuccess(result);
    expect(workspace.readContextOutput("all-window-scope-list")).toContain("own-all");
    expect(workspace.readContextOutput("all-window-scope-list")).not.toContain("untagged");
  }, 20_000);

  it("distinguishes git-root and all window scopes in git-root tmux sessions", async () => {
    const gitRootScoped = createWorkspace({
      tmuxSessionScope: "git-root",
      tmuxWindowScope: "git-root",
    });
    createPreexistingTmuxWindow(gitRootScoped, { title: "untagged-hidden" });

    const gitRootResult = await gitRootScoped.run({
      script: [
        bash("sleep 30", { background: true, name: "own-git-root-scope" }),
        scriptedToolCall("tmux", { action: "list" }, { delayMs: 500 }),
        captureLatestToolResult(gitRootScoped, {
          outputName: "git-root-scope-list",
          toolName: "tmux",
          assistantReply: "listed",
        }),
      ],
      prompt: "git-root scoped git-root session",
    });

    const allScoped = createWorkspace({ tmuxSessionScope: "git-root", tmuxWindowScope: "all" });
    createPreexistingTmuxWindow(allScoped, { title: "untagged-visible" });

    const allResult = await allScoped.run({
      script: [
        bash("sleep 30", { background: true, name: "own-all-scope" }),
        scriptedToolCall("tmux", { action: "list" }, { delayMs: 500 }),
        captureLatestToolResult(allScoped, {
          outputName: "all-scope-list",
          toolName: "tmux",
          assistantReply: "listed",
        }),
      ],
      prompt: "all scoped git-root session",
    });

    expectPiSuccess(gitRootResult);
    expectPiSuccess(allResult);
    expect(gitRootScoped.readContextOutput("git-root-scope-list")).toContain("own-git-root-scope");
    expect(gitRootScoped.readContextOutput("git-root-scope-list")).not.toContain("untagged-hidden");
    expect(allScoped.readContextOutput("all-scope-list")).toContain("own-all-scope");
    expect(allScoped.readContextOutput("all-scope-list")).not.toContain("untagged-visible");
  }, 30_000);

  it.each(testCases)(
    "$name",
    async (testCase) => {
      expectTestCase(testCase, await runTestCase(testCase));
    },
    40_000,
  );
});
