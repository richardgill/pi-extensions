import path from "node:path";
import { expect } from "vitest";
import { backgroundSessionName } from "../../src/tmux-utils.js";
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
    tmuxSession: () => tmuxSession,
    tmuxSessionExists: () => tmuxSessionExists(tmuxSession),
  };
};

export const expectPiSuccess = (result: RunPiResult): void => {
  expect(result.code, result.stdout + result.stderr).toBe(0);
};

const runPiForProject = (
  project: TempPiProject,
  options: PiE2eRunOptions,
): Promise<RunPiResult> => {
  const scriptedProvider = writeScriptedProvider(project.tempRoot, options.script);

  return runPi({
    cwd: project.projectDir,
    agentDir: project.agentDir,
    extensions: [path.resolve("extensions/tmux-bash/src/index.ts"), scriptedProvider],
    prompt: options.prompt ?? "run",
    timeoutMs: options.timeoutMs,
  });
};
