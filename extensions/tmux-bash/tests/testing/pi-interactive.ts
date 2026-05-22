import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { sleep } from "@richardgill/lib";
import { shellQuote } from "../../src/tmux-utils";

// Runs Pi interactively inside tmux and captures tmux pane output

export type RunPiTuiCheckpoint = {
  name: string;
  waitFor: string | RegExp;
  timeoutMs?: number;
  keys?: string[];
  delayMs?: number;
};

export type RunPiTuiOptions = {
  cwd: string;
  agentDir: string;
  extensions: string[];
  prompt: string;
  waitFor: string | RegExp;
  checkpoints?: RunPiTuiCheckpoint[];
  timeoutMs?: number;
  cols?: number;
  rows?: number;
  captureAnsi?: boolean;
};

export type RunPiTuiResult = {
  pane: string;
  checkpoints: Record<string, string>;
  paneAnsi?: string;
  checkpointsAnsi?: Record<string, string>;
};

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

const captureTmuxPane = (session: string, options: { ansi?: boolean } = {}): string =>
  tmux(["capture-pane", "-p", ...(options.ansi ? ["-e"] : []), "-J", "-S", "-", "-t", session]);

const paneMatches = (pane: string, matcher: string | RegExp): boolean =>
  typeof matcher === "string" ? pane.includes(matcher) : matcher.test(pane);

const waitForPane = async (
  session: string,
  matcher: string | RegExp,
  timeoutMs: number,
  deadline = Date.now() + timeoutMs,
): Promise<string> => {
  const paneCapture = captureTmuxPane(session);
  if (paneMatches(paneCapture, matcher)) return paneCapture;
  if (Date.now() >= deadline)
    throw new Error(`Timed out waiting for TUI output: ${String(matcher)}\n\n${paneCapture}`);

  await sleep(200);
  return waitForPane(session, matcher, timeoutMs, deadline);
};

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

const sendPrompt = async (session: string, prompt: string, timeoutMs: number): Promise<void> => {
  tmux(["send-keys", "-l", "-t", session, prompt]);
  await waitForPane(session, prompt, timeoutMs);
  await sleep(300);
  tmux(["send-keys", "-t", session, "Enter"]);
};

const sendKeys = (session: string, keys: string[] | undefined): void => {
  keys?.forEach((key) => tmux(["send-keys", "-t", session, key]));
};

const captureCheckpoint = async (
  session: string,
  checkpoint: RunPiTuiCheckpoint,
  defaultTimeoutMs: number,
  captureAnsi: boolean,
): Promise<[[string, string], [string, string] | undefined]> => {
  const pane = await waitForPane(
    session,
    checkpoint.waitFor,
    checkpoint.timeoutMs ?? defaultTimeoutMs,
  );
  const paneAnsi = captureAnsi ? captureTmuxPane(session, { ansi: true }) : undefined;
  sendKeys(session, checkpoint.keys);
  if (checkpoint.delayMs !== undefined) await sleep(checkpoint.delayMs);
  return [[checkpoint.name, pane], paneAnsi ? [checkpoint.name, paneAnsi] : undefined];
};

const captureCheckpoints = async (
  session: string,
  checkpoints: RunPiTuiCheckpoint[] | undefined,
  defaultTimeoutMs: number,
  captureAnsi: boolean,
): Promise<{
  plain: Record<string, string>;
  ansi?: Record<string, string>;
}> => {
  const plainEntries = [];
  const ansiEntries = [];
  for (const checkpoint of checkpoints ?? []) {
    const [plain, ansi] = await captureCheckpoint(
      session,
      checkpoint,
      defaultTimeoutMs,
      captureAnsi,
    );
    plainEntries.push(plain);
    if (ansi) ansiEntries.push(ansi);
  }
  return {
    plain: Object.fromEntries(plainEntries),
    ...(captureAnsi ? { ansi: Object.fromEntries(ansiEntries) } : {}),
  };
};

const killTmuxSession = (session: string): void => {
  try {
    tmux(["kill-session", "-t", session]);
  } catch {
    return;
  }
};

export const runPiTui = async (options: RunPiTuiOptions): Promise<RunPiTuiResult> => {
  const sessionName = `pi-tui-test-${process.pid}-${Date.now()}`;

  try {
    writeScriptedModelSettings(options.agentDir);
    startPiTui(sessionName, options);
    await sleep(1_000);
    const timeoutMs = options.timeoutMs ?? 20_000;
    await sendPrompt(sessionName, options.prompt, timeoutMs);
    const checkpoints = await captureCheckpoints(
      sessionName,
      options.checkpoints,
      timeoutMs,
      Boolean(options.captureAnsi),
    );
    const pane = await waitForPane(sessionName, options.waitFor, timeoutMs);
    return {
      pane,
      checkpoints: checkpoints.plain,
      ...(options.captureAnsi
        ? {
            paneAnsi: captureTmuxPane(sessionName, { ansi: true }),
            checkpointsAnsi: checkpoints.ansi,
          }
        : {}),
    };
  } finally {
    killTmuxSession(sessionName);
  }
};
