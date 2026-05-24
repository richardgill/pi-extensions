import { Container, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  keyHint,
  keyText,
  truncateTail,
  truncateToVisualLines,
  type BashToolDetails,
  type TruncationOptions,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { BASH_DURATION_SEPARATOR, DEFAULT_OPTIONS, type ResolvedOptions } from "./config";
import type { BashInput } from "./tool-call-schemas";

export type RenderTheme = {
  fg: (name: "toolTitle" | "toolOutput" | "muted" | "dim" | "warning", text: string) => string;
  bold: (text: string) => string;
};

export type BashOutputRenderLine =
  | { kind: "output"; text: string }
  | { kind: "fullOutputNotice"; text: string; displayText: string }
  | { kind: "truncationNotice"; text: string };

type BashOutputElisionLine =
  | { kind: "collapsedElision"; text: string; prefix: string; key: string; suffix: string }
  | { kind: "expandedElision"; text: string };

type RenderedBashOutputLine = BashOutputRenderLine | BashOutputElisionLine;

export type BashOutputRenderDetails = {
  lines: BashOutputRenderLine[];
  empty: boolean;
};

export type TmuxBashToolDetails = BashToolDetails & {
  outcome?: "timed-out-background";
  render: BashOutputRenderDetails;
};

export type FormattedOutput = {
  text: string;
  details: TmuxBashToolDetails;
};

type BashResultFormatOptions = {
  expanded: boolean;
  compactDisplayLines?: number;
  expandedDisplayLines?: number;
  truncatedCompactDisplayLines?: number;
};

type FormatTmuxOutputOptions = {
  fullOutputPath?: string;
  emptyText?: string;
  showFullOutputPath?: boolean;
  truncationOptions?: TruncationOptions;
};

type RenderBackgroundBashResultOptions = {
  raw: string;
  details?: BashOutputRenderDetails;
  expanded: boolean;
  theme: RenderTheme;
  options?: ResolvedOptions;
};

type BashResultTimingState = {
  startedAt?: number;
  endedAt?: number;
};

type RenderBashResultOptions = RenderBackgroundBashResultOptions & {
  isPartial: boolean;
  state: BashResultTimingState;
};

type FormatRenderedCompletionMessageOptions = {
  details: CompletionMessageRenderDetails;
  expanded: boolean;
  options?: ResolvedOptions;
};

type FormatRenderedPollMessageOptions = {
  details: PollMessageRenderDetails;
  expanded: boolean;
  options?: ResolvedOptions;
};

type RenderForegroundBashResultOptions = Omit<RenderBashResultOptions, "details"> & {
  details?: TmuxBashToolDetails;
};

export type CompletionMessageRenderDetails = {
  summary: string;
  output: BashOutputRenderDetails;
  exitCode: number;
  status: "success" | "failed";
};

class BashResultRenderComponent extends Container {}

class BashOutputPreviewComponent implements Component {
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;
  private cachedSkipped: number | undefined;

  constructor(
    private readonly output: string,
    private readonly theme: RenderTheme,
  ) {}

  render(width: number): string[] {
    if (this.cachedLines === undefined || this.cachedWidth !== width) {
      const preview = truncateToVisualLines(this.output, 5, width);
      this.cachedLines = preview.visualLines;
      this.cachedSkipped = preview.skippedCount;
      this.cachedWidth = width;
    }

    if (this.cachedSkipped && this.cachedSkipped > 0) {
      const hint =
        this.theme.fg("muted", `... (${this.cachedSkipped} earlier lines,`) +
        ` ${keyHint("app.tools.expand", "to expand")})`;
      return ["", truncateToWidth(hint, width, "..."), ...(this.cachedLines ?? [])];
    }

    return ["", ...(this.cachedLines ?? [])];
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.cachedSkipped = undefined;
  }
}

export type PollMessageRenderDetails = {
  summary: string;
  command: string;
  output: BashOutputRenderDetails;
  attachLines: string[];
};

export const displayCommandForCommand = (
  cmd: string,
  marker = DEFAULT_OPTIONS.displayCommandStartMarker,
): string => {
  if (!marker) return cmd;

  const lines = cmd.split("\n");
  const reversedMarkerIndex = [...lines].reverse().findIndex((line) => line.trim() === marker);
  if (reversedMarkerIndex === -1) return cmd;

  const markerLineIndex = lines.length - reversedMarkerIndex - 1;
  return (
    lines
      .slice(markerLineIndex + 1)
      .join("\n")
      .trimStart() || cmd
  );
};

const lastLineBytes = (content: string): number =>
  Buffer.byteLength(content.split("\n").at(-1) ?? "", "utf-8");

const exceedsLineLimit = (content: string, maxLines: number | undefined): boolean =>
  maxLines !== undefined && content.split("\n").length > maxLines;

const outputRenderDetails = (content: string, empty = false): BashOutputRenderDetails => ({
  lines: stripTrailingEmptyLines(content.split("\n")).map((text) => ({ kind: "output", text })),
  empty,
});

const fullOutputNoticeLine = (fullOutputPath: string): BashOutputRenderLine => ({
  kind: "fullOutputNotice",
  text: `[Full output: ${fullOutputPath}]`,
  displayText: `Full output: ${fullOutputPath}`,
});

const truncationNotice = (
  content: string,
  truncation: TruncationResult,
  fullOutputPath: string | undefined,
): string => {
  const startLine = truncation.totalLines - truncation.outputLines + 1;
  const endLine = truncation.totalLines;
  const suffix = fullOutputPath ? `. Full output: ${fullOutputPath}` : "";

  if (truncation.lastLinePartial) {
    const lineSize = formatSize(lastLineBytes(content));
    return `[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lineSize})${suffix}]`;
  }

  if (truncation.truncatedBy === "lines") {
    return `[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}${suffix}]`;
  }

  return `[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)${suffix}]`;
};

export const formatTmuxOutputForContext = (
  content: string,
  {
    fullOutputPath,
    emptyText = "(no output)",
    showFullOutputPath = false,
    truncationOptions = {},
  }: FormatTmuxOutputOptions = {},
): FormattedOutput => {
  const empty = !content.trim();
  const text = content.trim() || emptyText;
  const maxBytes = truncationOptions.maxBytes ?? DEFAULT_MAX_BYTES;
  const useRawSingleOversizedLine =
    content.endsWith("\n") && !text.includes("\n") && Buffer.byteLength(text, "utf-8") > maxBytes;
  const useRawLineTruncation = exceedsLineLimit(content, truncationOptions.maxLines);
  const truncationInput = useRawSingleOversizedLine || useRawLineTruncation ? content : text;
  const truncation = truncateTail(truncationInput, truncationOptions);
  const output = truncation.truncated ? truncation.content || emptyText : text;
  const notice: BashOutputRenderLine | undefined = truncation.truncated
    ? {
        kind: "truncationNotice",
        text: truncationNotice(truncationInput, truncation, fullOutputPath),
      }
    : showFullOutputPath && fullOutputPath
      ? fullOutputNoticeLine(fullOutputPath)
      : undefined;
  const render = outputRenderDetails(output, empty);

  return {
    text: notice ? `${output}\n\n${notice.text}` : output,
    details: {
      ...(truncation.truncated ? { truncation, fullOutputPath } : {}),
      ...(!truncation.truncated && notice ? { fullOutputPath } : {}),
      render: { lines: notice ? [...render.lines, notice] : render.lines, empty: render.empty },
    },
  };
};

export const limitOutputLines = (content: string, lines: number): string => {
  const trimmed = content.trimEnd();
  if (!trimmed) return "";

  return trimmed.split("\n").slice(-lines).join("\n");
};

export const formatCompletionSummary = (exitCode: number): string =>
  exitCode === 0 ? "Background bash finished" : "Background bash failed";

export const indentDisplayLine = (line: string): string => (line.trim() ? ` ${line}` : "");

export const indentDisplayLines = (lines: string[]): string[] => lines.map(indentDisplayLine);

const displayTextForLine = (line: RenderedBashOutputLine): string =>
  line.kind === "fullOutputNotice" ? line.displayText : line.text;

const displayTextForLines = (lines: RenderedBashOutputLine[]): string[] =>
  lines.map(displayTextForLine);

const truncateText = (text: string, maxLength: number): string =>
  text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;

const formatCompletionDetailLines = (lines: RenderedBashOutputLine[]): string[] =>
  displayTextForLines(
    lines.filter(
      (line) =>
        line.kind !== "fullOutputNotice" &&
        line.text.trim() !== "" &&
        !line.text.trimStart().startsWith("tmux: "),
    ),
  );

const bashCallCommand = (args: Partial<BashInput>): string =>
  truncateText((args.command ?? "...").replace(/\s+/g, " ").trim(), 80);

const bashBackgroundMetadata = (args: Partial<BashInput>): string => {
  const poll =
    args.pollInterval !== undefined && args.pollInterval > 0 ? `, poll ${args.pollInterval}s` : "";
  return `(background${poll})`;
};

const bashCallMetadata = (args: Partial<BashInput>): string[] => {
  if (args.background === true) return [bashBackgroundMetadata(args)];

  return [args.timeout !== undefined ? `(timeout ${args.timeout}s)` : undefined].filter(
    (item) => item !== undefined,
  );
};

export const formatRenderedBashCall = (args: Partial<BashInput>): string =>
  [`$ ${bashCallCommand(args)}`, ...bashCallMetadata(args)].join(" ");

export const renderBashCallText = (args: Partial<BashInput>, theme: RenderTheme): string =>
  `${theme.fg("toolTitle", theme.bold(`$ ${bashCallCommand(args)}`))}${bashCallMetadata(args)
    .map((item) => theme.fg("muted", ` ${item}`))
    .join("")}`;

const stripTrailingEmptyLines = (lines: string[]): string[] => {
  const reversedLastContentIndex = [...lines].reverse().findIndex((line) => line.trim() !== "");
  if (reversedLastContentIndex === -1) return [];

  return lines.slice(0, lines.length - reversedLastContentIndex);
};

const outputLines = (details: BashOutputRenderDetails): BashOutputRenderLine[] =>
  stripTrailingEmptyLines(
    details.lines.filter((line) => line.kind === "output").map((line) => line.text),
  ).map((text) => ({ kind: "output", text }));

const noticeLines = (details: BashOutputRenderDetails, expanded: boolean): BashOutputRenderLine[] =>
  details.lines.filter(
    (line) => line.kind === "truncationNotice" || (expanded && line.kind === "fullOutputNotice"),
  );

const collapsedElisionLine = (earlierLines: number): RenderedBashOutputLine => {
  const key = keyText("app.tools.expand");
  return {
    kind: "collapsedElision",
    text: `... (${earlierLines} earlier lines, ${key} to expand)`,
    prefix: `... (${earlierLines} earlier lines,`,
    key,
    suffix: " to expand",
  };
};

const expandedElisionLine = (earlierLines: number): RenderedBashOutputLine => ({
  kind: "expandedElision",
  text: `... (${earlierLines} earlier lines omitted)`,
});

const noticeResultLines = (notices: BashOutputRenderLine[]): BashOutputRenderLine[] =>
  notices.length > 0 ? [{ kind: "output", text: "" }, ...notices] : [];

const bashResultVisibleLineCount = (
  details: BashOutputRenderDetails,
  {
    expanded,
    compactDisplayLines = DEFAULT_OPTIONS.bashCompactDisplayLines,
    expandedDisplayLines = DEFAULT_OPTIONS.bashExpandedDisplayLines,
    truncatedCompactDisplayLines = compactDisplayLines,
  }: BashResultFormatOptions,
): number => {
  const collapsedDisplayLines = details.lines.some((line) => line.kind === "truncationNotice")
    ? truncatedCompactDisplayLines
    : compactDisplayLines;
  return expanded ? expandedDisplayLines : collapsedDisplayLines;
};

const renderedBashResultLines = (
  details: BashOutputRenderDetails,
  options: BashResultFormatOptions,
): RenderedBashOutputLine[] => {
  const lines = outputLines(details);
  const visibleOutputLineCount = bashResultVisibleLineCount(details, options);
  const notices = noticeLines(details, options.expanded);
  if (lines.length <= visibleOutputLineCount) {
    return [...lines, ...noticeResultLines(notices)];
  }

  const displayedOutputLines = lines.slice(-visibleOutputLineCount);
  const earlierLines = Math.max(0, lines.length - displayedOutputLines.length);
  return [
    options.expanded ? expandedElisionLine(earlierLines) : collapsedElisionLine(earlierLines),
    ...displayedOutputLines,
    ...noticeResultLines(notices),
  ];
};

export const formatRenderedBashResult = (
  details: BashOutputRenderDetails,
  options: BashResultFormatOptions,
): string =>
  renderedBashResultLines(details, options)
    .map((line) => line.text)
    .join("\n")
    .trimEnd();

const renderBashOutputLine = (line: RenderedBashOutputLine, theme: RenderTheme): string => {
  if (line.kind === "collapsedElision") {
    return (
      theme.fg("muted", line.prefix) +
      ` ${theme.fg("dim", line.key)}${theme.fg("muted", line.suffix)})`
    );
  }
  if (line.kind === "expandedElision") return theme.fg("muted", line.text);
  if (line.kind === "fullOutputNotice") return theme.fg("warning", line.text);

  return theme.fg("toolOutput", line.text);
};

const renderBashOutputLines = (lines: RenderedBashOutputLine[], theme: RenderTheme): string =>
  lines.map((line) => renderBashOutputLine(line, theme)).join("\n");

const durationSeconds = (ms: number): number => Math.max(0, ms / 1000);

export const formatDurationSeconds = (ms: number): string => `${Math.floor(durationSeconds(ms))}s`;

const formatElapsedDurationSeconds = (ms: number): string => `${durationSeconds(ms).toFixed(1)}s`;

const bashDurationText = (state: BashResultTimingState, isPartial: boolean): string | undefined => {
  if (state.startedAt === undefined) return undefined;

  const label = isPartial ? "Elapsed" : "Took";
  const endTime = state.endedAt ?? Date.now();
  const duration = formatElapsedDurationSeconds(endTime - state.startedAt);
  return `${label} ${duration}`;
};

const bashResultFormatOptions = (
  expanded: boolean,
  options: ResolvedOptions,
): BashResultFormatOptions => ({
  expanded,
  compactDisplayLines: options.bashCompactDisplayLines,
  expandedDisplayLines: options.bashExpandedDisplayLines,
  truncatedCompactDisplayLines: options.bashTruncatedCompactDisplayLines,
});

const completionResultFormatOptions = (
  expanded: boolean,
  options: ResolvedOptions,
): BashResultFormatOptions => ({
  expanded,
  compactDisplayLines: expanded
    ? options.completedExpandedDisplayLines
    : options.completedCompactDisplayLines,
  expandedDisplayLines: options.completedExpandedDisplayLines,
  truncatedCompactDisplayLines: options.completedTruncatedCompactDisplayLines,
});

const pollResultFormatOptions = (
  expanded: boolean,
  displayLines: number,
  options: ResolvedOptions,
): BashResultFormatOptions => ({
  expanded,
  compactDisplayLines: displayLines,
  expandedDisplayLines: displayLines,
  truncatedCompactDisplayLines: options.pollTruncatedCompactDisplayLines,
});

const bashResultOutputLines = (
  raw: string,
  details: BashOutputRenderDetails | undefined,
  expanded: boolean,
  options: ResolvedOptions,
): RenderedBashOutputLine[] =>
  renderedBashResultLines(
    details ?? outputRenderDetails(raw),
    bashResultFormatOptions(expanded, options),
  );

export const renderBackgroundBashResultText = ({
  raw,
  details,
  expanded,
  theme,
  options = DEFAULT_OPTIONS,
}: RenderBackgroundBashResultOptions): string => {
  const output = bashResultOutputLines(raw, details, expanded, options);
  const renderedOutput = output.length > 0 ? renderBashOutputLines(output, theme) : "";
  return renderedOutput ? `\n${renderedOutput}` : "";
};

export const renderBashResultText = ({
  raw,
  details,
  expanded,
  isPartial,
  state,
  theme,
  options = DEFAULT_OPTIONS,
}: RenderBashResultOptions): string => {
  const output = bashResultOutputLines(raw, details, expanded, options);
  const duration = bashDurationText(state, isPartial);
  const renderedOutput = output.length > 0 ? renderBashOutputLines(output, theme) : "";
  const renderedDuration = duration ? theme.fg("muted", duration) : "";

  if (!renderedOutput) return isPartial ? `\n${renderedDuration}` : renderedDuration;
  return [renderedOutput, renderedDuration].filter(Boolean).join(BASH_DURATION_SEPARATOR);
};

const stripFinalTruncationFooter = (
  output: string,
  details: TmuxBashToolDetails | undefined,
  isPartial: boolean,
): string => {
  if (
    isPartial ||
    !details?.truncation?.truncated ||
    !details.fullOutputPath ||
    !output.endsWith("]")
  ) {
    return output;
  }

  const footerStart = output.lastIndexOf("\n\n[");
  if (footerStart === -1 || !output.slice(footerStart).includes(details.fullOutputPath)) {
    return output;
  }

  return output.slice(0, footerStart).trimEnd();
};

const foregroundWarningText = (details: TmuxBashToolDetails | undefined): string | undefined => {
  const warnings: string[] = [];
  const truncation = details?.truncation;

  if (details?.fullOutputPath) warnings.push(`Full output: ${details.fullOutputPath}`);
  if (truncation?.truncated && truncation.truncatedBy === "lines") {
    warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
  }
  if (truncation?.truncated && truncation.truncatedBy !== "lines") {
    warnings.push(
      `Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
    );
  }

  return warnings.length > 0 ? `[${warnings.join(". ")}]` : undefined;
};

export const renderForegroundBashResultComponent = ({
  raw,
  details,
  expanded,
  isPartial,
  state,
  theme,
}: RenderForegroundBashResultOptions): Component => {
  const component = new BashResultRenderComponent();
  const output = stripFinalTruncationFooter(raw.trim(), details, isPartial);
  const duration = bashDurationText(state, isPartial);
  const warning = foregroundWarningText(details);

  if (output) {
    const styledOutput = output
      .split("\n")
      .map((line) => theme.fg("toolOutput", line))
      .join("\n");
    component.addChild(
      expanded
        ? new Text(`\n${styledOutput}`, 0, 0)
        : new BashOutputPreviewComponent(styledOutput, theme),
    );
  }

  if (warning) component.addChild(new Text(`\n${theme.fg("warning", warning)}`, 0, 0));
  if (duration) component.addChild(new Text(`\n${theme.fg("muted", duration)}`, 0, 0));

  return component;
};

export const hasOnlyEmptyBashOutput = (details: BashOutputRenderDetails): boolean =>
  details.empty && details.lines.every((line) => line.kind === "output");

export const formatRenderedCompletionMessage = ({
  details,
  expanded,
  options = DEFAULT_OPTIONS,
}: FormatRenderedCompletionMessageOptions): string => {
  if (hasOnlyEmptyBashOutput(details.output)) return details.summary;

  if (expanded) {
    const detailLines = displayTextForLines(
      renderedBashResultLines(details.output, completionResultFormatOptions(true, options)),
    ).slice(-options.completedExpandedDisplayLines);
    return [details.summary, ...indentDisplayLines(detailLines)].join("\n");
  }

  const output = renderedBashResultLines(
    details.output,
    completionResultFormatOptions(false, options),
  );
  const detailLines = formatCompletionDetailLines(output);
  if (detailLines.length === 0) return details.summary;

  return [details.summary, "", ...indentDisplayLines(detailLines)].join("\n");
};

const formatRenderedPollOutput = (
  command: string,
  output: BashOutputRenderDetails,
  expanded: boolean,
  displayLines: number,
  options: ResolvedOptions,
): string => {
  const compacted = formatRenderedBashResult(
    output,
    pollResultFormatOptions(expanded, displayLines, options),
  );
  const lines = [...(command ? [command] : []), ...(compacted ? compacted.split("\n") : [])];
  return indentDisplayLines(lines).join("\n");
};

export const formatRenderedPollMessage = ({
  details,
  expanded,
  options = DEFAULT_OPTIONS,
}: FormatRenderedPollMessageOptions): string => {
  const displayLines = expanded
    ? options.pollExpandedDisplayLines
    : options.pollCompactDisplayLines;
  const output = formatRenderedPollOutput(
    details.command,
    details.output,
    expanded,
    displayLines,
    options,
  );
  const rendered = [details.summary, output].filter(Boolean).join("\n\n");
  return details.attachLines.length > 0
    ? `${rendered}\n\n${details.attachLines.join("\n")}`
    : rendered;
};
