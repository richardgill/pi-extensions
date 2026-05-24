import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ResolvedOptions } from "../config";
import {
  formatRenderedCompletionMessage,
  formatRenderedPollMessage,
  indentDisplayLine,
  type BashOutputRenderDetails,
  type BashOutputRenderLine,
  type CompletionMessageRenderDetails,
  type PollMessageRenderDetails,
} from "../render";

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isBashOutputRenderLine = (value: unknown): value is BashOutputRenderLine => {
  if (!value || typeof value !== "object") return false;

  const line = value as Partial<BashOutputRenderLine>;
  if (typeof line.text !== "string") return false;
  if (line.kind === "output" || line.kind === "truncationNotice") return true;
  if (line.kind === "fullOutputNotice") return typeof line.displayText === "string";
  return false;
};

const isBashOutputRenderDetails = (value: unknown): value is BashOutputRenderDetails => {
  if (!value || typeof value !== "object") return false;

  const details = value as Partial<BashOutputRenderDetails>;
  return (
    Array.isArray(details.lines) &&
    details.lines.every(isBashOutputRenderLine) &&
    typeof details.empty === "boolean"
  );
};

const completionMessageRenderDetails = (
  value: unknown,
): CompletionMessageRenderDetails | undefined => {
  if (!value || typeof value !== "object") return undefined;

  const details = value as Partial<CompletionMessageRenderDetails>;
  if (typeof details.summary !== "string") return undefined;
  if (!isBashOutputRenderDetails(details.output)) return undefined;
  if (typeof details.exitCode !== "number") return undefined;
  if (details.status !== "success" && details.status !== "failed") return undefined;

  return {
    summary: details.summary,
    output: details.output,
    exitCode: details.exitCode,
    status: details.status,
  };
};

const pollMessageRenderDetails = (value: unknown): PollMessageRenderDetails | undefined => {
  if (!value || typeof value !== "object") return undefined;

  const details = value as Partial<PollMessageRenderDetails>;
  if (typeof details.summary !== "string") return undefined;
  if (typeof details.command !== "string") return undefined;
  if (!isBashOutputRenderDetails(details.output)) return undefined;
  if (!isStringArray(details.attachLines)) return undefined;

  return {
    summary: details.summary,
    command: details.command,
    output: details.output,
    attachLines: details.attachLines,
  };
};

export const registerMessageRenderers = (pi: ExtensionAPI, options: ResolvedOptions): void => {
  pi.registerMessageRenderer("tmux-bash-poll", (message, { expanded }, theme) => {
    const details = pollMessageRenderDetails(message.details);
    if (!details) throw new Error("Missing tmux-bash poll render details");

    const rendered = formatRenderedPollMessage({ details, expanded, options });
    const [summary = "", ...detail] = rendered.split("\n");
    return new Text(
      `${theme.fg("success", indentDisplayLine(summary))}${detail.length > 0 ? `\n${theme.fg("dim", detail.join("\n"))}` : ""}`,
      0,
      0,
    );
  });

  pi.registerMessageRenderer("tmux-bash-completion", (message, { expanded }, theme) => {
    const details = completionMessageRenderDetails(message.details);
    if (!details) throw new Error("Missing tmux-bash completion render details");

    const rendered = formatRenderedCompletionMessage({ details, expanded, options });
    const [summary = "", ...detail] = rendered.split("\n");
    const summaryColor = details.status === "failed" ? "error" : "success";
    return new Text(
      `${theme.fg(summaryColor, indentDisplayLine(summary))}${detail.length > 0 ? `\n${theme.fg("dim", detail.join("\n"))}` : ""}`,
      0,
      0,
    );
  });
};
