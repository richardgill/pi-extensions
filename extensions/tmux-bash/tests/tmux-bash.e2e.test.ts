import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { getWindows } from "../src/tmux-utils.js";
import { createPiE2eProject, expectPiSuccess, type PiE2eProject } from "./testing/e2e-project.js";
import {
  bash,
  recordLatestToolResult,
  replyIfContextContains,
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
  expectedTmuxSessionExists: boolean;
  timeoutMs?: number;
};

const createProject = (): PiE2eProject => {
  const project = createPiE2eProject();
  projects.push(project);
  return project;
};

const truncatedLongOutputContext = (
  _project: PiE2eProject,
  outputFile: string | undefined,
): string =>
  `${longLines.slice(100).join("\n")}\n\n[Showing lines 101-2100 of 2100. Full output: ${outputFile}]`;

const peekContextOutput = (project: PiE2eProject): string => {
  const index = getWindows(project.tmuxSession()).find(
    (window) => window.title === "peek-test",
  )?.index;
  return `── window ${index}: peek-test ──\n$ printf 'peek-me\\n'; sleep 30\npeek-me`;
};

const truncateContextPath = (project: PiE2eProject): string =>
  project.contextOutputPath("truncated-bash-context");

const peekContextPath = (project: PiE2eProject): string =>
  project.contextOutputPath("peek-context");

const findOutputFileWithContent = (project: PiE2eProject, content: string): string => {
  const match = project.outputFiles().find((file) => readFileSync(file, "utf8") === content);
  expect(match, `Output files: ${project.outputFiles().join(", ")}`).toBeDefined();
  return match!;
};

const testCases: TmuxBashE2eTestCase[] = [
  {
    name: "prints stdout exactly",
    script: () => [bash("printf 'hello\\n'"), replyIfContextContains("hello", "hello")],
    expectedTerminalOutput: "hello\n",
    expectedTmuxSessionExists: false,
  },
  {
    name: "captures stderr exactly",
    script: () => [bash("printf 'oops\\n' >&2"), replyIfContextContains("oops", "oops")],
    expectedTerminalOutput: "oops\n",
    expectedTmuxSessionExists: false,
  },
  {
    name: "reports non-zero exit codes",
    script: () => [
      bash("printf 'bad\\n'; exit 7"),
      replyIfContextContains("Command exited with code 7", "exit 7"),
    ],
    expectedTerminalOutput: "exit 7\n",
    expectedTmuxSessionExists: false,
  },
  {
    name: "kills timed-out foreground command",
    script: () => [
      bash("printf 'starting\\n'; sleep 5", {
        timeout: 1,
        timeoutAction: "kill",
      }),
      replyIfContextContains("Command timed out after 1 seconds", "timed out"),
    ],
    expectedTerminalOutput: "timed out\n",
    expectedTmuxSessionExists: false,
  },
  {
    name: "background command returns immediately and leaves session running",
    script: () => [
      bash("sleep 30", { background: true, name: "server" }),
      scriptedToolCall("tmux", { action: "list" }, { delayMs: 500 }),
      replyIfContextContains("Background session", "started"),
    ],
    expectedTerminalOutput: "started\n",
    expectedTmuxSessionExists: true,
  },
  {
    name: "lists background tmux windows",
    script: () => [
      bash("sleep 30", { background: true, name: "worker" }),
      scriptedToolCall("tmux", { action: "list" }, { delayMs: 500 }),
      replyIfContextContains("Background session", "listed"),
    ],
    expectedTerminalOutput: "listed\n",
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
      recordLatestToolResult(peekContextPath(project), "peeked", "tmux"),
    ],
    expectedTerminalOutput: "peeked\n",
    expectedContextOutputName: "peek-context",
    expectedContextOutput: peekContextOutput,
    expectedOutputFileContent: "peek-me\n",
    expectedTmuxSessionExists: true,
  },
  {
    name: "kills background session",
    script: () => [
      bash("sleep 30", { background: true, name: "kill-me" }),
      scriptedToolCall("tmux", { action: "kill" }),
      replyIfContextContains("Killed background session", "killed"),
    ],
    expectedTerminalOutput: "killed\n",
    expectedTmuxSessionExists: false,
  },
  {
    name: "truncates bash context output but preserves full output file",
    script: (project) => [
      bash(longOutputCommand),
      recordLatestToolResult(truncateContextPath(project), "truncated", "bash"),
    ],
    expectedTerminalOutput: "truncated\n",
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
      expect(project.tmuxSessionExists()).toBe(testCase.expectedTmuxSessionExists);

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
    },
    40_000,
  );
});
