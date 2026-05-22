import path from "node:path";
import { expect } from "vitest";
import { DEFAULT_OPTIONS } from "../../src/config";
import type { BashInput } from "../../src/tool-call-schemas";
import { backgroundSessionName } from "../../src/tmux-utils";
import {
  runBashToolDirectly,
  type DirectBashRunOptions,
  type DirectBashRunResult,
} from "./direct-tool";
import { runPi, type RunPiResult } from "./pi-dash-p";
import { type ScriptedStep, writeScriptedProvider } from "./scripted-provider";
import {
  createPiTestWorkspace,
  tmuxSessionExists,
  type PiTestWorkspace,
} from "./pi-test-workspace";

export type PiE2eRunOptions = {
  script: ScriptedStep[];
  prompt?: string;
  timeoutMs?: number;
};

export type PiE2eWorkspace = PiTestWorkspace & {
  run: (options: PiE2eRunOptions) => Promise<RunPiResult>;
  runBashTool: (input: BashInput, options?: DirectBashRunOptions) => Promise<DirectBashRunResult>;
  tmuxSession: () => string;
  tmuxSessionExists: () => boolean;
};

export const createPiE2eWorkspace = (
  options: { tmuxBashConfig?: Record<string, unknown> } = {},
): PiE2eWorkspace => {
  const workspace = createPiTestWorkspace(options);
  const tmuxSession = tmuxSessionNameForWorkspace(workspace);
  workspace.trackTmuxSession(tmuxSession);

  return {
    ...workspace,
    run: (options) => runPiForWorkspace(workspace, options),
    runBashTool: (input, options) => runBashToolDirectly(workspace, input, options),
    tmuxSession: () => tmuxSession,
    tmuxSessionExists: () => tmuxSessionExists(tmuxSession),
  };
};

export const expectPiSuccess = (result: RunPiResult): void => {
  expect(result.code, result.stdout + result.stderr).toBe(0);
};

const configString = (value: unknown, fallback: string): string =>
  typeof value === "string" ? value : fallback;

const tmuxSessionNameForWorkspace = (workspace: PiTestWorkspace): string => {
  if (workspace.tmuxBashConfig.tmuxSessionScope === "git-root") {
    const template = configString(
      workspace.tmuxBashConfig.gitRootTmuxSessionNameTemplate,
      DEFAULT_OPTIONS.gitRootTmuxSessionNameTemplate,
    );
    return backgroundSessionName(workspace.projectDir, template);
  }

  return configString(
    workspace.tmuxBashConfig.globalTmuxSessionName,
    DEFAULT_OPTIONS.globalTmuxSessionName,
  );
};

const extensionsForWorkspace = (workspace: PiTestWorkspace, script: ScriptedStep[]): string[] => {
  const scriptedProvider = writeScriptedProvider(workspace.tempRoot, script);
  return [path.resolve("extensions/tmux-bash/src/index.ts"), scriptedProvider];
};

const runPiForWorkspace = (
  workspace: PiTestWorkspace,
  options: PiE2eRunOptions,
): Promise<RunPiResult> =>
  runPi({
    cwd: workspace.projectDir,
    agentDir: workspace.agentDir,
    extensions: extensionsForWorkspace(workspace, options.script),
    prompt: options.prompt ?? "run",
    timeoutMs: options.timeoutMs,
  });
