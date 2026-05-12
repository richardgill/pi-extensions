import { execSync } from "node:child_process";
import { createHash } from "node:crypto";

export type TmuxWindow = {
  index: number;
  title: string;
  active: boolean;
  gitRoot?: string;
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

export const getWindows = (name: string, gitRoot?: string): TmuxWindow[] => {
  const raw = execSafe(
    `tmux list-windows -t ${shellQuote(name)} -F '#{window_index}|||#{window_name}|||#{window_active}|||#{@pi-tmux-bash-git-root}'`,
  );
  if (!raw) return [];

  const windows = raw.split("\n").map((line) => {
    const [index = "0", title = "", active = "0", windowGitRoot = ""] = line.split("|||");
    return {
      index: parseInt(index),
      title,
      active: active === "1",
      ...(windowGitRoot ? { gitRoot: windowGitRoot } : {}),
    };
  });

  return gitRoot === undefined ? windows : windows.filter((window) => window.gitRoot === gitRoot);
};

export const formatWindowLines = (windows: TmuxWindow[]): string[] =>
  windows.map(
    (window) => `  :${window.index}  ${window.title}${window.active ? "  (active)" : ""}`,
  );

export const capturePanes = (
  name: string,
  window: number | "all",
  lines = 50,
  gitRoot?: string,
): string => {
  const windows = getWindows(name, gitRoot);
  const targets = window === "all" ? windows : windows.filter((item) => item.index === window);

  if (targets.length === 0) return "No matching windows.";

  return targets
    .map((item) => {
      const output = execSafe(
        `tmux capture-pane -t ${shellQuote(`${name}:${item.index}`)} -p -S -${lines}`,
      );
      return `── window ${item.index}: ${item.title} ──\n${output ?? "(empty)"}`;
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
  gitRoot?: string,
): string => {
  const target = window === undefined ? session : `${session}:${window}`;
  if (!sessionExists(session)) return "No background tmux session for this project.";

  if (window !== undefined) {
    const windows = getWindows(session, gitRoot);
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
