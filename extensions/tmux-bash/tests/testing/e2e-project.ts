import path from "node:path";
import { expect } from "vitest";
import type { BashInput } from "../../src/tool-call-schemas.js";
import { backgroundSessionName } from "../../src/tmux-utils.js";
import {
  runBashToolDirectly,
  type DirectBashRunOptions,
  type DirectBashRunResult,
} from "./direct-tool.js";
import { runPi, type RunPiResult } from "./pi.js";
import { type ScriptedStep, writeScriptedProvider } from "./scripted-provider.js";
import { createTempPiProject, tmuxSessionExists, type TempPiProject } from "./temp-project.js";

export type PiE2eRunOptions = {
  script: ScriptedStep[];
  prompt?: string;
  timeoutMs?: number;
};

export type PiE2eProject = TempPiProject & {
  run: (options: PiE2eRunOptions) => Promise<RunPiResult>;
  runBashTool: (input: BashInput, options?: DirectBashRunOptions) => Promise<DirectBashRunResult>;
  tmuxSession: () => string;
  tmuxSessionExists: () => boolean;
};

export const createPiE2eProject = (
  options: { tmuxBashConfig?: Record<string, unknown> } = {},
): PiE2eProject => {
  const project = createTempPiProject(options);
  const tmuxSession = tmuxSessionNameForProject(project);
  project.trackTmuxSession(tmuxSession);

  return {
    ...project,
    run: (options) => runPiForProject(project, options),
    runBashTool: (input, options) => runBashToolDirectly(project, input, options),
    tmuxSession: () => tmuxSession,
    tmuxSessionExists: () => tmuxSessionExists(tmuxSession),
  };
};

export const expectPiSuccess = (result: RunPiResult): void => {
  expect(result.code, result.stdout + result.stderr).toBe(0);
};

const configString = (value: unknown, fallback: string): string =>
  typeof value === "string" ? value : fallback;

const tmuxSessionNameForProject = (project: TempPiProject): string => {
  if (project.tmuxBashConfig.tmuxSessionScope === "git-root") {
    const template = configString(
      project.tmuxBashConfig.gitRootTmuxSessionNameTemplate,
      "{gitRootSessionName}-bg",
    );
    return backgroundSessionName(project.projectDir, template);
  }

  return configString(project.tmuxBashConfig.globalTmuxSessionName, "pi-background");
};

const extensionsForProject = (project: TempPiProject, script: ScriptedStep[]): string[] => {
  const scriptedProvider = writeScriptedProvider(project.tempRoot, script);
  return [path.resolve("extensions/tmux-bash/src/index.ts"), scriptedProvider];
};

const runPiForProject = (project: TempPiProject, options: PiE2eRunOptions): Promise<RunPiResult> =>
  runPi({
    cwd: project.projectDir,
    agentDir: project.agentDir,
    extensions: extensionsForProject(project, options.script),
    prompt: options.prompt ?? "run",
    timeoutMs: options.timeoutMs,
  });
