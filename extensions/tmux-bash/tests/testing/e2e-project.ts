import path from "node:path";
import { expect } from "vitest";
import type { BashInput } from "../../src/tool-call-schemas.js";
import { backgroundSessionName } from "../../src/tmux-utils.js";
import { runBashToolDirectly, type DirectBashRunResult } from "./direct-tool.js";
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
  runBashTool: (input: BashInput) => Promise<DirectBashRunResult>;
  tmuxSession: () => string;
  tmuxSessionExists: () => boolean;
};

export const createPiE2eProject = (): PiE2eProject => {
  const project = createTempPiProject();
  const tmuxSession = backgroundSessionName(project.projectDir);
  project.trackTmuxSession(tmuxSession);

  return {
    ...project,
    run: (options) => runPiForProject(project, options),
    runBashTool: (input) => runBashToolDirectly(project, input),
    tmuxSession: () => tmuxSession,
    tmuxSessionExists: () => tmuxSessionExists(tmuxSession),
  };
};

export const expectPiSuccess = (result: RunPiResult): void => {
  expect(result.code, result.stdout + result.stderr).toBe(0);
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
