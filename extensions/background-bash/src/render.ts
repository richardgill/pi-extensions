import { stripVTControlCharacters } from "node:util";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { BackgroundBashDetails } from "./process-manager";

export type CompletionRenderDetails = {
  status: "success" | "failed";
  pgid: number;
  name?: string;
  command: string;
  elapsedMs: number;
  exitCode?: number;
  logPath: string;
  truncated: boolean;
};

type RenderTheme = {
  fg: (
    color: "dim" | "error" | "success" | "toolOutput" | "toolTitle" | "warning",
    text: string,
  ) => string;
  bold: (text: string) => string;
};

const sanitizeDisplayText = (text: string): string =>
  Array.from(stripVTControlCharacters(text))
    .filter((character) => {
      const code = character.codePointAt(0);
      return (
        code === 0x09 ||
        code === 0x0a ||
        (code !== undefined &&
          code > 0x1f &&
          !(code >= 0xd800 && code <= 0xdfff) &&
          !(code >= 0xfff9 && code <= 0xfffb))
      );
    })
    .join("");

export const resultText = (
  result: AgentToolResult<BackgroundBashDetails | undefined> | undefined,
): string => {
  const content = result?.content[0];
  return content?.type === "text" ? content.text : "";
};

const logPathFromText = (text: string): string | undefined =>
  text.match(/Full output: ([^\]\n]+)/)?.[1]?.trim();

const pgidFromLogPath = (path: string | undefined): number | undefined => {
  const value = path?.match(/\/(\d+)\.log$/)?.[1];
  return value ? Number(value) : undefined;
};

export const stripModelOnlyLogLine = (text: string, logPath: string | undefined): string => {
  if (!logPath) return text;
  return text
    .split("\n")
    .filter((line) => line.trim() !== `Full output: ${logPath}`)
    .join("\n")
    .trimEnd();
};

const processControls = (pgid: number): string =>
  [`Inspect group: pgrep -a -g ${pgid}`, `Kill group:    kill -KILL -- -${pgid}`].join("\n");

export const sanitizedResult = (
  result: AgentToolResult<BackgroundBashDetails | undefined>,
): {
  result: AgentToolResult<BackgroundBashDetails | undefined>;
  logPath?: string;
  pgid?: number;
  truncated: boolean;
} => {
  const raw = resultText(result);
  const details = result.details;
  const logPath = details?.fullOutputPath ?? logPathFromText(raw);
  const pgid = details?.pgid ?? pgidFromLogPath(logPath);
  const truncated = Boolean(details?.truncation?.truncated) || raw.includes("[Showing ");
  const text = stripModelOnlyLogLine(raw, logPath);

  return {
    result: {
      ...result,
      content: [{ type: "text", text }],
      details: truncated
        ? { ...details, fullOutputPath: logPath }
        : details
          ? { ...details, fullOutputPath: undefined }
          : undefined,
    },
    logPath,
    pgid,
    truncated,
  };
};

export const renderProcessResult = (
  result: AgentToolResult<BackgroundBashDetails | undefined>,
  theme: RenderTheme,
): Component => {
  const display = sanitizedResult(result);
  const content = sanitizeDisplayText(resultText(display.result));
  const active = Boolean(result.details?.active);
  const log =
    display.logPath && (active || display.truncated)
      ? `${display.truncated ? "Full output" : "Log"}: ${display.logPath}`
      : "";
  const controls = active && display.pgid ? processControls(display.pgid) : "";
  const details = sanitizeDisplayText([log, controls].filter(Boolean).join("\n"));
  const suffix = details ? `\n\n${theme.fg("warning", details)}` : "";
  return new Text(`${theme.fg("toolOutput", content)}${suffix}`, 0, 0);
};

export const appendHints = (
  component: Component,
  result: AgentToolResult<BackgroundBashDetails | undefined>,
  theme: RenderTheme,
): Component => {
  const display = sanitizedResult(result);
  if (!result.details?.active || !display.logPath) return component;
  if (!(component instanceof Container)) return component;

  const log = display.truncated ? "" : `Log: ${display.logPath}`;
  const controls = display.truncated && display.pgid ? processControls(display.pgid) : "";
  const details = sanitizeDisplayText([log, controls].filter(Boolean).join("\n"));
  if (details) component.addChild(new Text(`\n${theme.fg("warning", details)}`, 0, 0));
  return component;
};

export const renderCompletionMessage = (
  content: string,
  details: CompletionRenderDetails,
  theme: RenderTheme,
): Component => {
  const display = sanitizeDisplayText(stripModelOnlyLogLine(content, details.logPath));
  const separator = display.indexOf("\n\n");
  const output = separator === -1 ? "" : display.slice(separator + 2).trim();
  const label = sanitizeDisplayText(details.name ?? "Background bash");
  const elapsed = `${(details.elapsedMs / 1000).toFixed(1)}s`;
  const exit =
    details.status === "failed" && details.exitCode !== undefined
      ? ` (exit ${details.exitCode})`
      : "";
  const summary = `${details.status === "success" ? "✓" : "✗"} ${label} ${details.status === "success" ? "finished" : "failed"} in ${elapsed}${exit}`;
  const logPath = details.truncated ? `Full output: ${details.logPath}` : "";
  const command = sanitizeDisplayText(details.command);
  const body = [`  $ ${command}`, output, logPath].filter(Boolean).join("\n\n");
  const color = details.status === "success" ? "success" : "error";
  return new Text(`${theme.fg(color, summary)}\n${theme.fg("dim", body)}`, 0, 0);
};

export const renderProcessCall = (
  args: { action?: string; pgid?: number },
  toolName: string,
  theme: RenderTheme,
): Component => {
  const suffix = sanitizeDisplayText(
    [args.action, args.pgid].filter((value) => value !== undefined).join(" "),
  );
  return new Text(
    `${theme.fg("toolTitle", theme.bold(sanitizeDisplayText(toolName)))}${suffix ? ` ${theme.fg("dim", suffix)}` : ""}`,
    0,
    0,
  );
};
