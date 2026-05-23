import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { runPiTui } from "./testing/pi-interactive";
import { createPiE2eWorkspace, type PiE2eWorkspace } from "./testing/pi-test-utils";
import {
  bash,
  recordLatestToolResult,
  type ScriptedStep,
  writeScriptedProvider,
} from "./testing/scripted-provider";
import { stableAnsiBashTranscript, stableContextOutput } from "./testing/tui-transcript";

const doneMarker = "PI-VANILLA-PARITY-DONE";
const contextOutputName = "bash-context";

type BashParityCase = {
  name: string;
  command: string;
};

type BashRunResult = {
  transcript: string;
  context: string;
};

type BashParityResult = {
  vanilla: BashRunResult;
  tmuxBash: BashRunResult;
};

const parityCases: BashParityCase[] = [
  {
    name: "output fits collapsed view",
    command: "printf 'fit-line-1\\nfit-line-2\\nfit-line-3\\n'",
  },
  {
    name: "output overflows collapsed view but fits context limits",
    command: "for i in $(seq 1 400); do printf 'overflow-line-%03d\\n' \"$i\"; done",
  },
  {
    name: "output exceeds context limits",
    command: "for i in $(seq 1 4000); do printf 'truncated-line-%03d\\n' \"$i\"; done",
  },
  {
    name: "single output line exceeds 50kb byte limit",
    command: `python3 -c "print('x' * 60000)"`,
  },
];

const createWorkspace = (): PiE2eWorkspace => {
  const workspace = createPiE2eWorkspace();
  onTestFinished(() => workspace.cleanup());
  return workspace;
};

const runTui = async (
  workspace: PiE2eWorkspace,
  script: ScriptedStep[],
  options: { tmuxBash: boolean },
): Promise<string> => {
  const scriptedProvider = writeScriptedProvider(workspace.tempRoot, script);
  const extensions = options.tmuxBash
    ? [path.resolve("extensions/tmux-bash/src/index.ts"), scriptedProvider]
    : [scriptedProvider];
  const result = await runPiTui({
    cwd: workspace.projectDir,
    agentDir: workspace.agentDir,
    extensions,
    prompt: "run scripted bash parity call",
    waitFor: doneMarker,
    captureAnsi: true,
    timeoutMs: 30_000,
  });

  return stableAnsiBashTranscript(result.paneAnsi ?? "", doneMarker);
};

const contextPath = (workspace: PiE2eWorkspace): string =>
  workspace.contextOutputPath(contextOutputName);

const scriptForWorkspace = (
  workspace: PiE2eWorkspace,
  testCase: BashParityCase,
): ScriptedStep[] => [
  bash(testCase.command),
  recordLatestToolResult(contextPath(workspace), { toolName: "bash", text: doneMarker }),
];

const runPiBash = async (
  testCase: BashParityCase,
  options: { tmuxBash: boolean },
): Promise<BashRunResult> => {
  const workspace = createWorkspace();
  const transcript = await runTui(workspace, scriptForWorkspace(workspace, testCase), options);
  const context = stableContextOutput(workspace.readContextOutput(contextOutputName));

  return { transcript, context };
};

const runCase = async (testCase: BashParityCase): Promise<BashParityResult> => {
  const vanilla = await runPiBash(testCase, { tmuxBash: false });
  const tmuxBash = await runPiBash(testCase, { tmuxBash: true });

  return { vanilla, tmuxBash };
};

const expectVanillaParity = async (testCase: BashParityCase): Promise<void> => {
  const { vanilla, tmuxBash } = await runCase(testCase);

  expect(tmuxBash.transcript).toBe(vanilla.transcript);
  expect(tmuxBash.context).toBe(vanilla.context);
};

describe("tmux-bash vanilla pi TUI parity", () => {
  it.each(parityCases)(
    "matches vanilla ANSI bash rendering and model context when $name",
    async (testCase) => {
      await expectVanillaParity(testCase);
    },
    60_000,
  );
});
