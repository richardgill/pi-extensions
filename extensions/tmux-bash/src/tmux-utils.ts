import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { ResolvedOptions } from "./config";

export type TmuxWindow = {
  id: string;
  index: number;
  title: string;
  active: boolean;
  createdAt?: number;
  gitRoot?: string;
  piSessionId?: string;
  outputFile?: string;
  displayCommand?: string;
};

export type TmuxWindowFilters = {
  gitRoot?: string;
  piSessionId?: string;
};

export const TMUX_WINDOW_OPTIONS = {
  startedAt: "@pi-tmux-bash-started-at",
  gitRoot: "@pi-tmux-bash-git-root",
  piSessionId: "@pi-tmux-bash-pi-session-id",
  outputFile: "@pi-tmux-bash-output-file",
  displayCommand: "@pi-tmux-bash-display-command",
} as const;

export const tmuxFormatOption = (option: string): string => `#{${option}}`;

export const exec = (cmd: string): string =>
  execSync(cmd, {
    encoding: "utf-8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

export const execSafe = (cmd: string): string | null => {
  try {
    return exec(cmd);
  } catch {
    return null;
  }
};

export const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

export const getGitRoot = (cwd: string): string | null => {
  try {
    return execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
};

const projectSessionName = (gitRoot: string): string => {
  const slug = gitRoot.split("/").pop()?.slice(0, 16).toLowerCase() ?? "project";
  const hash = createHash("md5").update(gitRoot).digest("hex").slice(0, 8);
  return `${slug}-${hash}`;
};

export const backgroundSessionName = (gitRoot: string, template: string): string =>
  template.replace(/{{\s*gitRootSessionName\s*}}/g, projectSessionName(gitRoot));

export const calcTmuxSessionName = (gitRoot: string, options: ResolvedOptions): string =>
  options.tmuxSessionScope === "global"
    ? options.globalTmuxSessionName
    : backgroundSessionName(gitRoot, options.gitRootTmuxSessionNameTemplate);

export const tmuxWindowFiltersForScope = (
  gitRoot: string,
  piSessionId: string,
  options: ResolvedOptions,
): TmuxWindowFilters => {
  if (options.tmuxWindowScope === "pi-session") return { piSessionId };
  if (options.tmuxWindowScope === "git-root") return { gitRoot };
  return {};
};

export const sessionExists = (name: string, tmuxBinary = "tmux"): boolean =>
  execSafe(
    `${shellQuote(tmuxBinary)} has-session -t ${shellQuote(name)} 2>/dev/null && echo yes`,
  ) === "yes";

const matchesWindowFilters = (window: TmuxWindow, filters: TmuxWindowFilters): boolean =>
  (filters.gitRoot === undefined || window.gitRoot === filters.gitRoot) &&
  (filters.piSessionId === undefined || window.piSessionId === filters.piSessionId);

const windowListFormat = [
  "#{window_id}",
  "#{window_index}",
  "#{window_name}",
  "#{window_active}",
  tmuxFormatOption(TMUX_WINDOW_OPTIONS.startedAt),
  tmuxFormatOption(TMUX_WINDOW_OPTIONS.gitRoot),
  tmuxFormatOption(TMUX_WINDOW_OPTIONS.piSessionId),
  tmuxFormatOption(TMUX_WINDOW_OPTIONS.outputFile),
  tmuxFormatOption(TMUX_WINDOW_OPTIONS.displayCommand),
].join("|||");

export const getWindows = (
  name: string,
  filters?: TmuxWindowFilters,
  tmuxBinary = "tmux",
): TmuxWindow[] => {
  const raw = execSafe(
    `${shellQuote(tmuxBinary)} list-windows -t ${shellQuote(name)} -F ${shellQuote(windowListFormat)}`,
  );
  if (!raw) return [];

  const windowFilters = filters ?? {};
  return raw
    .split("\n")
    .map((line) => {
      const [
        id = "",
        index = "0",
        title = "",
        active = "0",
        createdAt = "",
        windowGitRoot = "",
        piSessionId = "",
        outputFile = "",
        displayCommand = "",
      ] = line.split("|||");
      return {
        id,
        index: parseInt(index),
        title,
        active: active === "1",
        ...(createdAt ? { createdAt: parseInt(createdAt) } : {}),
        ...(windowGitRoot ? { gitRoot: windowGitRoot } : {}),
        ...(piSessionId ? { piSessionId } : {}),
        ...(outputFile ? { outputFile } : {}),
        ...(displayCommand ? { displayCommand } : {}),
      };
    })
    .filter((window) => matchesWindowFilters(window, windowFilters));
};

const formatWindowAge = (window: TmuxWindow, now = Date.now()): string | undefined => {
  if (window.createdAt === undefined || !Number.isFinite(window.createdAt)) return undefined;
  const ageSeconds = Math.max(0, Math.floor((now - window.createdAt * 1000) / 1000));
  if (ageSeconds < 60) return `${ageSeconds}s`;
  const ageMinutes = Math.floor(ageSeconds / 60);
  if (ageMinutes < 60) return `${ageMinutes}m`;
  const ageHours = Math.floor(ageMinutes / 60);
  if (ageHours < 24) return `${ageHours}h`;
  return `${Math.floor(ageHours / 24)}d`;
};

const tmuxCommandText = (tmuxBinary: string): string =>
  tmuxBinary === "tmux" ? "tmux" : shellQuote(tmuxBinary);

export const tmuxWindowAttachCommand = (
  windowId: string,
  env: NodeJS.ProcessEnv,
  tmuxBinary: string,
): string =>
  env.TMUX
    ? `${tmuxCommandText(tmuxBinary)} switch-client -t ${windowId}`
    : `${tmuxCommandText(tmuxBinary)} attach -t ${windowId}`;

export const tmuxWindowAttachHint = (
  windowId: string,
  env: NodeJS.ProcessEnv,
  tmuxBinary: string,
): string => `Attach with: ${tmuxWindowAttachCommand(windowId, env, tmuxBinary)}`;

export const formatWindowLines = (windows: TmuxWindow[]): string[] =>
  windows.map((window) => {
    const age = formatWindowAge(window);
    return `  ${window.title} ${window.id}${age ? ` (${age})` : ""}`;
  });
