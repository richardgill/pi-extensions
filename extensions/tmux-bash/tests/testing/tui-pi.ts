import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { shellQuote } from "../../src/tmux-utils.js";

export type RunPiTuiOptions = {
  cwd: string;
  agentDir: string;
  extensions: string[];
  prompt: string;
  waitFor: string | RegExp;
  timeoutMs?: number;
  cols?: number;
  rows?: number;
};

export type RunPiTuiResult = {
  pane: string;
};

const tmuxSessionName = (): string => `pi-tui-test-${process.pid}-${Date.now()}`;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const buildPiArgs = (extensions: string[]): string[] => [
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
  "--offline",
  ...extensions.flatMap((extension) => ["-e", extension]),
  "--provider",
  "scripted",
  "--model",
  "scripted",
];

const buildPiCommand = (options: RunPiTuiOptions): string => {
  const piBin = path.resolve("node_modules/.bin/pi");
  const env = [
    `PI_CODING_AGENT_DIR=${shellQuote(options.agentDir)}`,
    `PI_EXTENSION_CONFIG_DIR=${shellQuote(options.agentDir)}`,
    "TERM=xterm-256color",
  ];
  const args = buildPiArgs(options.extensions).map(shellQuote);

  return ["env", ...env, shellQuote(piBin), ...args].join(" ");
};

const tmux = (args: string[]): string => execFileSync("tmux", args, { encoding: "utf8" });

const capturePane = (session: string): string =>
  tmux(["capture-pane", "-p", "-J", "-S", "-", "-t", session]);

const paneMatches = (pane: string, matcher: string | RegExp): boolean =>
  typeof matcher === "string" ? pane.includes(matcher) : matcher.test(pane);

const waitForPaneUntil = async (
  session: string,
  matcher: string | RegExp,
  deadline: number,
): Promise<string> => {
  const pane = capturePane(session);
  if (paneMatches(pane, matcher)) return pane;
  if (Date.now() >= deadline)
    throw new Error(`Timed out waiting for TUI output: ${String(matcher)}\n\n${pane}`);

  await sleep(200);
  return waitForPaneUntil(session, matcher, deadline);
};

const waitForPane = (
  session: string,
  matcher: string | RegExp,
  timeoutMs: number,
): Promise<string> => waitForPaneUntil(session, matcher, Date.now() + timeoutMs);

const writeScriptedModelSettings = (agentDir: string): void => {
  writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify(
      {
        defaultProvider: "scripted",
        defaultModel: "scripted",
        enabledModels: ["scripted/scripted"],
      },
      null,
      2,
    ),
    "utf8",
  );
};

const startPiTui = (session: string, options: RunPiTuiOptions): void => {
  tmux([
    "new-session",
    "-d",
    "-x",
    String(options.cols ?? 160),
    "-y",
    String(options.rows ?? 60),
    "-s",
    session,
    "-c",
    options.cwd,
    buildPiCommand(options),
  ]);
};

const sendPrompt = (session: string, prompt: string): void => {
  tmux(["send-keys", "-l", "-t", session, prompt]);
  tmux(["send-keys", "-t", session, "Enter"]);
};

const killTmuxSession = (session: string): void => {
  try {
    tmux(["kill-session", "-t", session]);
  } catch {
    return;
  }
};

export const runPiTui = async (options: RunPiTuiOptions): Promise<RunPiTuiResult> => {
  const session = tmuxSessionName();

  try {
    writeScriptedModelSettings(options.agentDir);
    startPiTui(session, options);
    await sleep(1_000);
    sendPrompt(session, options.prompt);
    const pane = await waitForPane(session, options.waitFor, options.timeoutMs ?? 20_000);
    return { pane };
  } finally {
    killTmuxSession(session);
  }
};
