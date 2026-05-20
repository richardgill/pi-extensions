import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { formatDurationSeconds } from "../src/extension.js";
import { getWindows } from "../src/tmux-utils.js";
import { createPiE2eProject, expectPiSuccess, type PiE2eProject } from "./testing/e2e-project.js";
import {
  bash,
  recordLatestToolResult,
  scriptedToolCall,
  type ScriptedStep,
} from "./testing/scripted-provider.js";

const projects: PiE2eProject[] = [];
const longLines = Array.from(
  { length: 2100 },
  (_, index) => `line-${String(index + 1).padStart(4, "0")}`,
);
const longOutput = `${longLines.join("\n")}\n`;
const longOutputCommand = "for i in $(seq 1 2100); do printf 'line-%04d\\n' \"$i\"; done";

type TmuxBashE2eTestCase = {
  name: string;
  script: (project: PiE2eProject) => ScriptedStep[];
  expectedTerminalOutput: string;
  expectedContextOutputName?: string;
  expectedContextOutput?: (project: PiE2eProject, outputFile: string | undefined) => string;
  expectedOutputFileContent?: string;
  expectedLatestToolResult?: { toolName: string; isError: boolean };
  expectedTmuxSessionExists?: boolean;
  timeoutMs?: number;
};

const createProject = (): PiE2eProject => {
  const project = createPiE2eProject();
  projects.push(project);
  return project;
};

const fullOutputNotice = (outputFile: string | undefined): string => `[Full output: ${outputFile}]`;

const bashOutputContext =
  (text: string) =>
  (_project: PiE2eProject, outputFile: string | undefined): string =>
    `${text}\n\n${fullOutputNotice(outputFile)}`;

const failedBashContext = (_project: PiE2eProject, outputFile: string | undefined): string =>
  `bad\n\n${fullOutputNotice(outputFile)}\n\nCommand exited with code 7`;

const timeoutBashContext = (_project: PiE2eProject, outputFile: string | undefined): string =>
  `starting\n\n${fullOutputNotice(outputFile)}\n\nCommand timed out after 1 seconds`;

const truncatedLongOutputContext = (
  _project: PiE2eProject,
  outputFile: string | undefined,
): string =>
  `${longLines.slice(100).join("\n")}\n\n[Showing lines 101-2100 of 2100. Full output: ${outputFile}]`;

const listContext =
  (title: string) =>
  (project: PiE2eProject): string => {
    const window = getWindows(project.tmuxSession()).find((item) => item.title === title);
    return `Background session ${project.tmuxSession()} — 1 window(s)\n  :${window?.index}  ${title}${window?.active ? "  (active)" : ""}`;
  };

const killContext = (project: PiE2eProject): string =>
  `Killed background session ${project.tmuxSession()}.`;

const peekContextOutput = (project: PiE2eProject): string => {
  const index = getWindows(project.tmuxSession()).find(
    (window) => window.title === "peek-test",
  )?.index;
  return `── window ${index}: peek-test ──\n$ printf 'peek-me\\n'; sleep 30\npeek-me`;
};

const contextPath = (project: PiE2eProject, name: string): string =>
  project.contextOutputPath(name);

const firstUpdateMatching = (
  updates: { text: string; elapsedMs: number }[],
  pattern: RegExp,
): { text: string; elapsedMs: number } | undefined =>
  updates.find((update) => pattern.test(update.text));

const recordContext = (
  project: PiE2eProject,
  name: string,
  toolName: string,
  text: string,
): ScriptedStep => recordLatestToolResult(contextPath(project, name), { toolName, text });

const findOutputFileWithContent = (project: PiE2eProject, content: string): string => {
  const match = project.outputFiles().find((file) => readFileSync(file, "utf8") === content);
  expect(match, `Output files: ${project.outputFiles().join(", ")}`).toBeDefined();
  return match!;
};

const testCases: TmuxBashE2eTestCase[] = [
  {
    name: "prints stdout exactly",
    script: (project) => [
      bash("printf 'hello\\n'"),
      recordContext(project, "stdout-context", "bash", "stdout-ok"),
    ],
    expectedTerminalOutput: "stdout-ok\n",
    expectedContextOutputName: "stdout-context",
    expectedContextOutput: bashOutputContext("hello"),
    expectedOutputFileContent: "hello\n",
    expectedLatestToolResult: { toolName: "bash", isError: false },
    expectedTmuxSessionExists: false,
  },
  {
    name: "captures stderr exactly",
    script: (project) => [
      bash("printf 'oops\\n' >&2"),
      recordContext(project, "stderr-context", "bash", "stderr-ok"),
    ],
    expectedTerminalOutput: "stderr-ok\n",
    expectedContextOutputName: "stderr-context",
    expectedContextOutput: bashOutputContext("oops"),
    expectedOutputFileContent: "oops\n",
    expectedTmuxSessionExists: false,
  },
  {
    name: "captures delayed foreground stdout exactly",
    script: (project) => [
      bash('echo "hello" && sleep 5 && echo "bye"', { timeout: 10 }),
      recordContext(project, "delayed-stdout-context", "bash", "delayed-ok"),
    ],
    expectedTerminalOutput: "delayed-ok\n",
    expectedContextOutputName: "delayed-stdout-context",
    expectedContextOutput: bashOutputContext("hello\nbye"),
    expectedOutputFileContent: "hello\nbye\n",
    expectedTmuxSessionExists: false,
    timeoutMs: 20_000,
  },
  {
    name: "reports non-zero exit codes",
    script: (project) => [
      bash("printf 'bad\\n'; exit 7"),
      recordContext(project, "failed-context", "bash", "failed-ok"),
    ],
    expectedTerminalOutput: "failed-ok\n",
    expectedContextOutputName: "failed-context",
    expectedContextOutput: failedBashContext,
    expectedOutputFileContent: "bad\n",
    expectedLatestToolResult: { toolName: "bash", isError: true },
    expectedTmuxSessionExists: false,
  },
  {
    name: "kills timed-out foreground command",
    script: (project) => [
      bash("printf 'starting\\n'; sleep 5", {
        timeout: 1,
        timeoutAction: "kill",
      }),
      recordContext(project, "timeout-context", "bash", "timeout-ok"),
    ],
    expectedTerminalOutput: "timeout-ok\n",
    expectedContextOutputName: "timeout-context",
    expectedContextOutput: timeoutBashContext,
    expectedOutputFileContent: "starting\n",
    expectedLatestToolResult: { toolName: "bash", isError: true },
    expectedTmuxSessionExists: false,
  },
  {
    name: "background command renders start output",
    script: (project) => [
      bash("sleep 90", { background: true }),
      recordContext(project, "background-start-context", "bash", "started-ok"),
    ],
    expectedTerminalOutput: "started-ok\n",
    expectedContextOutputName: "background-start-context",
    expectedContextOutput: () => "Started in background tmux window.",
  },
  {
    name: "background command returns immediately and leaves session running",
    script: (project) => [
      bash("sleep 30", { background: true, name: "server" }),
      scriptedToolCall("tmux", { action: "list" }, { delayMs: 500 }),
      recordContext(project, "server-list-context", "tmux", "listed-ok"),
    ],
    expectedTerminalOutput: "listed-ok\n",
    expectedContextOutputName: "server-list-context",
    expectedContextOutput: listContext("server"),
    expectedTmuxSessionExists: true,
  },
  {
    name: "lists background tmux windows",
    script: (project) => [
      bash("sleep 30", { background: true, name: "worker" }),
      scriptedToolCall("tmux", { action: "list" }, { delayMs: 500 }),
      recordContext(project, "worker-list-context", "tmux", "worker-listed"),
    ],
    expectedTerminalOutput: "worker-listed\n",
    expectedContextOutputName: "worker-list-context",
    expectedContextOutput: listContext("worker"),
    expectedTmuxSessionExists: true,
  },
  {
    name: "peeks background tmux output",
    script: (project) => [
      bash("printf 'peek-me\\n'; sleep 30", {
        background: true,
        name: "peek-test",
      }),
      scriptedToolCall("tmux", { action: "peek", window: "all" }, { delayMs: 500 }),
      recordContext(project, "peek-context", "tmux", "peek-ok"),
    ],
    expectedTerminalOutput: "peek-ok\n",
    expectedContextOutputName: "peek-context",
    expectedContextOutput: peekContextOutput,
    expectedOutputFileContent: "peek-me\n",
    expectedTmuxSessionExists: true,
  },
  {
    name: "kills background session",
    script: (project) => [
      bash("sleep 30", { background: true, name: "kill-me" }),
      scriptedToolCall("tmux", { action: "kill" }),
      recordContext(project, "kill-context", "tmux", "killed-ok"),
    ],
    expectedTerminalOutput: "killed-ok\n",
    expectedContextOutputName: "kill-context",
    expectedContextOutput: killContext,
    expectedTmuxSessionExists: false,
  },
  {
    name: "truncates bash context output but preserves full output file",
    script: (project) => [
      bash(longOutputCommand),
      recordContext(project, "truncated-bash-context", "bash", "truncated-ok"),
    ],
    expectedTerminalOutput: "truncated-ok\n",
    expectedContextOutputName: "truncated-bash-context",
    expectedContextOutput: truncatedLongOutputContext,
    expectedOutputFileContent: longOutput,
    expectedTmuxSessionExists: false,
  },
];

afterEach(() => {
  projects.forEach((project) => project.cleanup());
  projects.length = 0;
});

describe("tmux-bash e2e", () => {
  it("formats foreground bash duration without trailing decimal", () => {
    expect(formatDurationSeconds(5_000)).toBe("5s");
    expect(formatDurationSeconds(10_000)).toBe("10s");
  });

  it("streams foreground stdout before command completion", async () => {
    const project = createProject();
    const result = await project.runBashTool({
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
    const project = createProject();
    const result = await project.runBashTool(
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

    expect(pollMessage?.content).not.toContain("line-1");
    expect(pollMessage?.content).not.toContain("line-2");
    expect(pollMessage?.content).toContain("line-3");
    expect(pollMessage?.content).toContain("line-4");
    expect(pollMessage?.triggerTurn).toBe(false);
    expect(pollMessage?.deliverAs).toBe("followUp");
  }, 20_000);

  it("does not resend unchanged background poll output", async () => {
    const project = createProject();
    const result = await project.runBashTool(
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

  it.each(testCases)(
    "$name",
    async (testCase) => {
      const project = createProject();

      const result = await project.run({
        script: testCase.script(project),
        prompt: testCase.name,
        timeoutMs: testCase.timeoutMs,
      });

      expectPiSuccess(result);
      expect(result.terminalOutput).toBe(testCase.expectedTerminalOutput);
      if (testCase.expectedTmuxSessionExists !== undefined) {
        expect(project.tmuxSessionExists()).toBe(testCase.expectedTmuxSessionExists);
      }

      const outputFile = testCase.expectedOutputFileContent
        ? findOutputFileWithContent(project, testCase.expectedOutputFileContent)
        : undefined;

      if (testCase.expectedOutputFileContent && outputFile) {
        expect(readFileSync(outputFile, "utf8")).toBe(testCase.expectedOutputFileContent);
      }

      if (testCase.expectedContextOutputName) {
        expect(project.readContextOutput(testCase.expectedContextOutputName)).toBe(
          testCase.expectedContextOutput?.(project, outputFile),
        );
      }

      if (testCase.expectedLatestToolResult) {
        const expected = testCase.expectedLatestToolResult;
        expect(project.latestToolResult(expected.toolName)?.isError).toBe(expected.isError);
      }
    },
    40_000,
  );
});
