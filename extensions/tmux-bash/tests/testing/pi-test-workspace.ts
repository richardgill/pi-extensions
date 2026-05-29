import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TMUX_ACTIONS } from "../../src/config";

export type PiTestWorkspace = {
  tempRoot: string;
  projectDir: string;
  agentDir: string;
  outputDir: string;
  contextDir: string;
  tmuxBashConfig: Record<string, unknown>;
  contextOutputPath: (name: string) => string;
  readContextOutput: (name: string) => string;
  outputFiles: () => string[];
  latestToolResult: (toolName: string) => ToolResultMessage | undefined;
  trackTmuxSession: (session: string) => void;
  cleanup: () => void;
};

type ToolResultMessage = {
  role: "toolResult";
  toolName: string;
  isError: boolean;
  content: { type: string; text?: string }[];
};

export const createPiTestWorkspace = (
  options: { tmuxBashConfig?: Record<string, unknown> } = {},
): PiTestWorkspace => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "pi-tmux-bash-e2e-"));
  const projectDir = path.join(tempRoot, "project");
  const agentDir = path.join(tempRoot, "agent");
  const outputDir = path.join(tempRoot, "output");
  const contextDir = path.join(tempRoot, "context");
  const tmuxSessions: string[] = [];
  const tmuxBashConfig = buildTmuxBashConfig(outputDir, tempRoot, options.tmuxBashConfig);

  initGitRepo(projectDir);
  writeTmuxBashConfig(agentDir, tmuxBashConfig);

  return {
    tempRoot,
    projectDir,
    agentDir,
    outputDir,
    contextDir,
    tmuxBashConfig,
    contextOutputPath: (name) => path.join(contextDir, `${name}.txt`),
    readContextOutput: (name) => readFileSync(path.join(contextDir, `${name}.txt`), "utf8"),
    outputFiles: () => findOutputFiles(outputDir),
    latestToolResult: (toolName) => latestToolResult(agentDir, toolName),
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

const buildTmuxBashConfig = (
  outputDir: string,
  tempRoot: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  outputDir,
  preserveOutputFiles: true,
  globalTmuxSessionName: `pi-tmux-bash-e2e-${path.basename(tempRoot)}`,
  tmuxEnabledActions: [...TMUX_ACTIONS],
  bashPollIntervalEnabled: true,
  ...overrides,
});

const writeTmuxBashConfig = (agentDir: string, config: Record<string, unknown>): void => {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(path.join(agentDir, "tmux-bash.jsonc"), JSON.stringify(config, null, 2), "utf8");
};

const findOutputFiles = (root: string): string[] => {
  if (!existsSync(root)) return [];

  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".out"))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
};

const sessionFiles = (agentDir: string): string[] => {
  const sessionsDir = path.join(agentDir, "sessions");
  if (!existsSync(sessionsDir)) return [];

  return readdirSync(sessionsDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
};

const sessionMessages = (agentDir: string): unknown[] =>
  sessionFiles(agentDir).flatMap((file) =>
    readFileSync(file, "utf8").trim().split("\n").flatMap(parseSessionMessage),
  );

const parseSessionMessage = (line: string): unknown[] => {
  try {
    return [JSON.parse(line).message];
  } catch {
    return [];
  }
};

const isToolResult = (value: unknown): value is ToolResultMessage =>
  typeof value === "object" && value !== null && (value as ToolResultMessage).role === "toolResult";

const latestToolResult = (agentDir: string, toolName: string): ToolResultMessage | undefined =>
  sessionMessages(agentDir)
    .filter(isToolResult)
    .filter((message) => message.toolName === toolName)
    .at(-1);

const killTmuxSession = (session: string): void => {
  try {
    execFileSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
  } catch {
    return;
  }
};
