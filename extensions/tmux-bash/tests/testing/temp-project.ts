import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export type TempPiProject = {
  tempRoot: string;
  projectDir: string;
  agentDir: string;
  trackTmuxSession: (session: string) => void;
  cleanup: () => void;
};

export const createTempPiProject = (): TempPiProject => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "pi-tmux-bash-e2e-"));
  const projectDir = path.join(tempRoot, "project");
  const agentDir = path.join(tempRoot, "agent");
  const tmuxSessions: string[] = [];

  initGitRepo(projectDir);

  return {
    tempRoot,
    projectDir,
    agentDir,
    trackTmuxSession: (session) => tmuxSessions.push(session),
    cleanup: () => {
      tmuxSessions.forEach(killTmuxSession);
      rmSync(tempRoot, { recursive: true, force: true });
    },
  };
};

export const tmuxSessionExists = (session: string): boolean => {
  try {
    execFileSync("tmux", ["has-session", "-t", session], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const initGitRepo = (cwd: string): void => {
  mkdirSync(cwd, { recursive: true });
  execFileSync("git", ["init"], { cwd, stdio: "ignore" });
};

const killTmuxSession = (session: string): void => {
  try {
    execFileSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
  } catch {
    return;
  }
};
