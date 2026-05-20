import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPiE2eProject, type PiE2eProject } from "./testing/e2e-project.js";
import {
  bash,
  recordLatestToolResult,
  type ScriptedStep,
  writeScriptedProvider,
} from "./testing/scripted-provider.js";
import { runPiTui } from "./testing/tui-pi.js";

const projects: PiE2eProject[] = [];
const doneMarker = "PI-VANILLA-PARITY-DONE";
const ANSI_ESCAPE_PATTERN =
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[()][A-Za-z0-9])/g;

type BashParityCase = {
  name: string;
  command: string;
  skipIssueLinks?: string;
};

type BashParityResult = {
  vanilla: string;
  tmuxBash: string;
  vanillaContext: string;
  tmuxBashContext: string;
};

const parityCases: BashParityCase[] = [
  {
    name: "output fits collapsed view",
    command: "printf 'fit-line-1\\nfit-line-2\\nfit-line-3\\n'",
  },
  {
    name: "output overflows collapsed view but fits context limits",
    command: "for i in $(seq 1 400); do printf 'overflow-line-%03d\\n' \"$i\"; done",
    skipIssueLinks: "https://github.com/earendil-works/pi/issues/4818",
  },
  {
    name: "output exceeds context limits",
    command: "for i in $(seq 1 4000); do printf 'truncated-line-%03d\\n' \"$i\"; done",
    skipIssueLinks:
      "https://github.com/earendil-works/pi/issues/4818 https://github.com/earendil-works/pi/issues/4819",
  },
  {
    name: "single output line exceeds 50kb byte limit",
    command: `python3 -c "print('x' * 60000)"`,
  },
];

const activeParityCases = parityCases.filter((testCase) => !testCase.skipIssueLinks);
const skippedParityCases = parityCases.filter((testCase) => testCase.skipIssueLinks);

const createProject = (): PiE2eProject => {
  const project = createPiE2eProject();
  projects.push(project);
  return project;
};

const stripAnsi = (text: string): string => text.replace(ANSI_ESCAPE_PATTERN, "");

const ansiTokens = (line: string): { text: string; ansi: boolean }[] => {
  const tokens = [];
  let index = 0;
  for (const match of line.matchAll(ANSI_ESCAPE_PATTERN)) {
    const matchIndex = match.index ?? 0;
    if (matchIndex > index) {
      tokens.push(...Array.from(line.slice(index, matchIndex), (text) => ({ text, ansi: false })));
    }
    tokens.push({ text: match[0], ansi: true });
    index = matchIndex + match[0].length;
  }
  tokens.push(...Array.from(line.slice(index), (text) => ({ text, ansi: false })));
  return tokens;
};

const lastVisibleContentIndex = (tokens: { text: string; ansi: boolean }[]): number =>
  tokens.reduce(
    (last, token, index) => (!token.ansi && token.text.trim() !== "" ? index : last),
    -1,
  );

const trimAnsiLineEnd = (line: string): string => {
  const tokens = ansiTokens(line);
  const lastContentIndex = lastVisibleContentIndex(tokens);
  if (lastContentIndex === -1) return "";

  return tokens
    .slice(0, lastContentIndex + 1)
    .map((token) => token.text)
    .join("");
};

const ansiBashTranscript = (pane: string): string => {
  const lines = pane.split("\n");
  const visibleLines = lines.map((line) => stripAnsi(line).trim());
  const start = visibleLines.findIndex((line) => line.startsWith("$ "));
  if (start === -1) throw new Error(`Missing ANSI bash call in pane:\n${pane}`);

  const end = visibleLines.findIndex((line, index) => index > start && line === doneMarker);
  if (end === -1) throw new Error(`Missing ANSI done marker in pane:\n${pane}`);

  return lines.slice(start, end).map(trimAnsiLineEnd).join("\n").trimEnd();
};

const normalizeWrappedFullOutputPaths = (text: string): string => {
  const lines = text.split("\n");
  const normalized = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const visible = stripAnsi(line).trim();
    const nextVisible = stripAnsi(lines[index + 1] ?? "").trim();

    const isStandaloneFullOutputNotice = visible === "[Full output: <path>]";
    if (visible.includes("Full output:") && !visible.endsWith("]") && nextVisible.startsWith("/")) {
      normalized.push(`${line.replace(/\s*$/, "")} <path>]`);
      index += 1;
    } else if (visible.startsWith("[Full output: <path>") && nextVisible.startsWith("Truncated:")) {
      index += 1;
    } else if (!isStandaloneFullOutputNotice) {
      normalized.push(line);
    }
  }

  return normalized.join("\n").replace(/\n{3,}/g, "\n\n");
};

const stableAnsiBashTranscript = (pane: string): string =>
  normalizeWrappedFullOutputPaths(
    ansiBashTranscript(pane)
      .replace(/Took [0-9]+\.[0-9]s/g, "Took <duration>")
      .replace(/Full output: [^\]\x1b\n]+/g, "Full output: <path>"),
  );

const stableContextOutput = (text: string): string =>
  normalizeWrappedFullOutputPaths(
    text.replace(/Full output: [^\]\n]+/g, "Full output: <path>"),
  ).trimEnd();

const runTui = async (
  project: PiE2eProject,
  script: ScriptedStep[],
  options: { tmuxBash: boolean },
): Promise<string> => {
  const scriptedProvider = writeScriptedProvider(project.tempRoot, script);
  const extensions = options.tmuxBash
    ? [path.resolve("extensions/tmux-bash/src/index.ts"), scriptedProvider]
    : [scriptedProvider];
  const result = await runPiTui({
    cwd: project.projectDir,
    agentDir: project.agentDir,
    extensions,
    prompt: "run scripted bash parity call",
    waitFor: doneMarker,
    captureAnsi: true,
    timeoutMs: 30_000,
  });

  return stableAnsiBashTranscript(result.paneAnsi ?? "");
};

const contextPath = (project: PiE2eProject): string => project.contextOutputPath("bash-context");

const scriptForProject = (project: PiE2eProject, testCase: BashParityCase): ScriptedStep[] => [
  bash(testCase.command),
  recordLatestToolResult(contextPath(project), { toolName: "bash", text: doneMarker }),
];

const runCase = async (testCase: BashParityCase): Promise<BashParityResult> => {
  const vanillaProject = createProject();
  const tmuxBashProject = createProject();
  const vanillaScript = scriptForProject(vanillaProject, testCase);
  const tmuxBashScript = scriptForProject(tmuxBashProject, testCase);
  const vanilla = await runTui(vanillaProject, vanillaScript, { tmuxBash: false });
  const tmuxBash = await runTui(tmuxBashProject, tmuxBashScript, { tmuxBash: true });
  const vanillaContext = stableContextOutput(vanillaProject.readContextOutput("bash-context"));
  const tmuxBashContext = stableContextOutput(tmuxBashProject.readContextOutput("bash-context"));

  return { vanilla, tmuxBash, vanillaContext, tmuxBashContext };
};

afterEach(() => {
  projects.forEach((project) => project.cleanup());
  projects.length = 0;
});

describe("tmux-bash vanilla pi TUI parity", () => {
  it.each(activeParityCases)(
    "matches vanilla ANSI bash rendering and model context when $name",
    async (testCase) => {
      const { vanilla, tmuxBash, vanillaContext, tmuxBashContext } = await runCase(testCase);

      expect(tmuxBash).toBe(vanilla);
      expect(tmuxBashContext).toBe(vanillaContext);
    },
    60_000,
  );

  it.skip.each(skippedParityCases)(
    "matches vanilla ANSI bash rendering and model context when $name (blocked by $skipIssueLinks)",
    async (testCase) => {
      const { vanilla, tmuxBash, vanillaContext, tmuxBashContext } = await runCase(testCase);

      expect(tmuxBash).toBe(vanilla);
      expect(tmuxBashContext).toBe(vanillaContext);
    },
    60_000,
  );
});
