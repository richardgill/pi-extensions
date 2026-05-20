import { execSync } from "node:child_process";
import { createHash } from "node:crypto";

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

export const exec = (cmd: string): string =>
  execSync(cmd, { encoding: "utf-8", timeout: 10_000 }).trim();

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

export const DEFAULT_SESSION_NAME_TEMPLATE = "{gitRootSessionName}-bg";

const projectSessionName = (gitRoot: string): string => {
  const slug = gitRoot.split("/").pop()?.slice(0, 16).toLowerCase() ?? "project";
  const hash = createHash("md5").update(gitRoot).digest("hex").slice(0, 8);
  return `${slug}-${hash}`;
};

export const backgroundSessionName = (
  gitRoot: string,
  template = DEFAULT_SESSION_NAME_TEMPLATE,
): string => template.replaceAll("{gitRootSessionName}", projectSessionName(gitRoot));

export const sessionExists = (name: string): boolean =>
  execSafe(`tmux has-session -t ${shellQuote(name)} 2>/dev/null && echo yes`) === "yes";

const normalizeWindowFilters = (filters?: string | TmuxWindowFilters): TmuxWindowFilters =>
  typeof filters === "string" ? { gitRoot: filters } : (filters ?? {});

const matchesWindowFilters = (window: TmuxWindow, filters: TmuxWindowFilters): boolean =>
  (filters.gitRoot === undefined || window.gitRoot === filters.gitRoot) &&
  (filters.piSessionId === undefined || window.piSessionId === filters.piSessionId);

export const getWindows = (name: string, filters?: string | TmuxWindowFilters): TmuxWindow[] => {
  const raw = execSafe(
    `tmux list-windows -t ${shellQuote(name)} -F '#{window_id}|||#{window_index}|||#{window_name}|||#{window_active}|||#{@pi-tmux-bash-started-at}|||#{@pi-tmux-bash-git-root}|||#{@pi-tmux-bash-pi-session-id}|||#{@pi-tmux-bash-output-file}|||#{@pi-tmux-bash-display-command}'`,
  );
  if (!raw) return [];

  const windowFilters = normalizeWindowFilters(filters);
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

const formatAgeUnit = (value: number, unit: string): string => `${value}${unit}`;

export const formatWindowAge = (window: TmuxWindow, now = Date.now()): string | undefined => {
  if (window.createdAt === undefined || !Number.isFinite(window.createdAt)) return undefined;
  const ageSeconds = Math.max(0, Math.floor((now - window.createdAt * 1000) / 1000));
  if (ageSeconds < 60) return formatAgeUnit(ageSeconds, "s");
  const ageMinutes = Math.floor(ageSeconds / 60);
  if (ageMinutes < 60) return formatAgeUnit(ageMinutes, "m");
  const ageHours = Math.floor(ageMinutes / 60);
  if (ageHours < 24) return formatAgeUnit(ageHours, "h");
  return formatAgeUnit(Math.floor(ageHours / 24), "d");
};

export const tmuxWindowAttachCommand = (
  windowId: string,
  env: NodeJS.ProcessEnv = process.env,
): string => (env.TMUX ? `tmux switch-client -t ${windowId}` : `tmux attach -t ${windowId}`);

export const tmuxWindowAttachHint = (
  windowId: string,
  env: NodeJS.ProcessEnv = process.env,
): string => `Attach with: ${tmuxWindowAttachCommand(windowId, env)}`;

export const formatWindowLines = (windows: TmuxWindow[]): string[] =>
  windows.map((window) => {
    const age = formatWindowAge(window);
    return `  ${window.title} ${window.id}${age ? ` (${age})` : ""}`;
  });
