import { execSync } from "node:child_process";
import { createHash } from "node:crypto";

export type TmuxWindow = {
  id: string;
  index: number;
  title: string;
  active: boolean;
  gitRoot?: string;
  piSessionId?: string;
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

export const DEFAULT_SESSION_NAME_TEMPLATE = "{{}}-bg";

const projectSessionName = (gitRoot: string): string => {
  const slug = gitRoot.split("/").pop()?.slice(0, 16).toLowerCase() ?? "project";
  const hash = createHash("md5").update(gitRoot).digest("hex").slice(0, 8);
  return `${slug}-${hash}`;
};

export const backgroundSessionName = (
  gitRoot: string,
  template = DEFAULT_SESSION_NAME_TEMPLATE,
): string => template.replaceAll("{{}}", projectSessionName(gitRoot));

export const sessionExists = (name: string): boolean =>
  execSafe(`tmux has-session -t ${shellQuote(name)} 2>/dev/null && echo yes`) === "yes";

const normalizeWindowFilters = (filters?: string | TmuxWindowFilters): TmuxWindowFilters =>
  typeof filters === "string" ? { gitRoot: filters } : (filters ?? {});

const matchesWindowFilters = (window: TmuxWindow, filters: TmuxWindowFilters): boolean =>
  (filters.gitRoot === undefined || window.gitRoot === filters.gitRoot) &&
  (filters.piSessionId === undefined || window.piSessionId === filters.piSessionId);

export const getWindows = (name: string, filters?: string | TmuxWindowFilters): TmuxWindow[] => {
  const raw = execSafe(
    `tmux list-windows -t ${shellQuote(name)} -F '#{window_id}|||#{window_index}|||#{window_name}|||#{window_active}|||#{@pi-tmux-bash-git-root}|||#{@pi-tmux-bash-pi-session-id}'`,
  );
  if (!raw) return [];

  const windowFilters = normalizeWindowFilters(filters);
  return raw
    .split("\n")
    .map((line) => {
      const [id = "", index = "0", title = "", active = "0", windowGitRoot = "", piSessionId = ""] =
        line.split("|||");
      return {
        id,
        index: parseInt(index),
        title,
        active: active === "1",
        ...(windowGitRoot ? { gitRoot: windowGitRoot } : {}),
        ...(piSessionId ? { piSessionId } : {}),
      };
    })
    .filter((window) => matchesWindowFilters(window, windowFilters));
};

type FormatWindowLinesOptions = {
  attachHints?: boolean;
  stableIds?: boolean;
};

export const tmuxWindowAttachCommand = (
  windowId: string,
  env: NodeJS.ProcessEnv = process.env,
): string => (env.TMUX ? `tmux switch-client -t ${windowId}` : `tmux attach -t ${windowId}`);

export const tmuxWindowAttachHint = (
  windowId: string,
  env: NodeJS.ProcessEnv = process.env,
): string => `Attach with: ${tmuxWindowAttachCommand(windowId, env)}`;

const windowTargetLabel = (window: TmuxWindow, options: FormatWindowLinesOptions): string =>
  options.stableIds ? window.id : `:${window.index}`;

export const formatWindowLines = (
  windows: TmuxWindow[],
  options: FormatWindowLinesOptions = {},
): string[] =>
  windows.map((window) =>
    [
      `  ${windowTargetLabel(window, options)}  ${window.title}${window.active ? "  (active)" : ""}`,
      ...(options.attachHints ? [`    ${tmuxWindowAttachHint(window.id)}`] : []),
    ].join("\n"),
  );

export const capturePanes = (
  name: string,
  window: number | "all",
  lines = 50,
  filters?: string | TmuxWindowFilters,
): string => {
  const windows = getWindows(name, filters);
  const targets = window === "all" ? windows : windows.filter((item) => item.index === window);

  if (targets.length === 0) return "No matching windows.";

  return targets
    .map((item) => {
      const output = execSafe(
        `tmux capture-pane -t ${shellQuote(`${name}:${item.index}`)} -p -S -${lines}`,
      );
      return `── window ${item.title} ──\n${output ?? "(empty)"}\n\n${tmuxWindowAttachHint(item.id)}`;
    })
    .join("\n\n");
};

const openTerminalTab = (session: string, window?: number): string => {
  const target = window === undefined ? session : `${session}:${window}`;
  const attachCmd = `tmux attach -t ${shellQuote(target)}`;
  const term = process.env.TERM_PROGRAM ?? "";

  if (process.env.TMUX) {
    exec(`tmux switch-client -t ${shellQuote(target)}`);
    return `Switched tmux client to ${target}.`;
  }

  if (term === "iTerm.app") {
    exec(
      `osascript -e ${shellQuote(`
      tell application "iTerm2"
        tell current window
          set newTab to (create tab with default profile)
          tell current session of newTab
            write text ${JSON.stringify(attachCmd)}
          end tell
        end tell
      end tell`)}`,
    );
    return `Opened iTerm2 tab attached to ${target}.`;
  }

  if (term === "Apple_Terminal") {
    exec(
      `osascript -e ${shellQuote(`
      tell application "Terminal"
        activate
        do script ${JSON.stringify(attachCmd)}
      end tell`)}`,
    );
    return `Opened Terminal.app window attached to ${target}.`;
  }

  if (term === "kitty") {
    exec(`kitty @ launch --type=tab ${attachCmd}`);
    return `Opened kitty tab attached to ${target}.`;
  }

  if (term === "ghostty") {
    exec(`ghostty -e ${attachCmd} &`);
    return `Opened ghostty window attached to ${target}.`;
  }

  if (term === "WezTerm") {
    exec(`wezterm cli spawn -- ${attachCmd}`);
    return `Opened WezTerm tab attached to ${target}.`;
  }

  return `No supported terminal detected. Run manually:\n  ${attachCmd}`;
};

export const attachToResolvedSession = (
  session: string,
  window?: number,
  filters?: string | TmuxWindowFilters,
): string => {
  const target = window === undefined ? session : `${session}:${window}`;
  if (!sessionExists(session)) return "No background tmux session for this project.";

  if (window !== undefined) {
    const windows = getWindows(session, filters);
    const match = windows.find((item) => item.index === window);
    if (!match) {
      const available = formatWindowLines(windows);
      return available.length > 0
        ? `No tmux window :${window} in session ${session}.\nAvailable windows:\n${available.join("\n")}`
        : `No tmux window :${window} in session ${session}.`;
    }
  }

  try {
    return openTerminalTab(session, window);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Failed: ${message}\nRun manually:\n  tmux attach -t ${shellQuote(target)}`;
  }
};
