import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ResolvedOptions } from "../config";
import {
  renderPromptTemplate,
  resolveSystemPromptToolSnippet,
  systemPromptGuidelines,
} from "../system-prompt";
import { executeTool, toolError, type ExtensionState } from "../runtime";
import { buildTmuxToolCallSchema } from "../tool-call-schemas";

type TmuxToolRenderTheme = {
  fg: (name: "success" | "dim", text: string) => string;
};

type TmuxRenderDetails = {
  summary: string;
  expandedLines: string[];
  collapsedLines: string[];
  attachLines?: string[];
};

const TARGETED_TMUX_ACTIONS = ["peek", "kill", "poll", "unpoll"];

const formatTmuxCallWindowLabel = (action: string, window: number | string | undefined): string => {
  if (!TARGETED_TMUX_ACTIONS.includes(action) || window === undefined) return "";

  const target = String(window);
  return target.startsWith("@") ? ` ${target}` : ` :${target}`;
};

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const getTmuxRenderDetails = (details: unknown): TmuxRenderDetails | undefined => {
  if (!details || typeof details !== "object") return undefined;

  const render = (details as { render?: Partial<TmuxRenderDetails> }).render;
  if (typeof render?.summary !== "string") return undefined;
  if (!isStringArray(render.expandedLines) || !isStringArray(render.collapsedLines)) {
    return undefined;
  }
  if (render.attachLines !== undefined && !isStringArray(render.attachLines)) return undefined;

  return {
    summary: render.summary,
    expandedLines: render.expandedLines,
    collapsedLines: render.collapsedLines,
    attachLines: render.attachLines,
  };
};

const formatTmuxToolRenderText = (
  render: TmuxRenderDetails,
  expanded: boolean,
  theme: TmuxToolRenderTheme,
): string => {
  const detailLines = expanded ? render.expandedLines : render.collapsedLines;

  return [
    `${theme.fg("success", "✓ ")}${render.summary}`,
    ...detailLines,
    ...(render.attachLines ?? []),
  ].join("\n");
};

export const registerTmuxTool = (
  pi: ExtensionAPI,
  state: ExtensionState,
  options: ResolvedOptions,
): void => {
  const tmuxToolCallSchema = buildTmuxToolCallSchema(options, toolError);

  pi.registerTool({
    name: options.tmuxToolName,
    label: options.tmuxToolName,
    description: renderPromptTemplate(options.tmuxToolDescription, options),
    promptSnippet: resolveSystemPromptToolSnippet(options.tmuxSystemPromptSnippet, options),
    promptGuidelines: systemPromptGuidelines(options),
    parameters: tmuxToolCallSchema.typeBoxSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return tmuxToolCallSchema.handleInput(params, (input) =>
        executeTool(input, ctx, state, pi, options),
      );
    },
    renderCall(args, theme) {
      const tmuxArgs = args as Partial<{ action: string; window: number | string }>;
      const action = tmuxArgs.action ?? options.tmuxToolName;
      const windowLabel = formatTmuxCallWindowLabel(action, tmuxArgs.window);
      return new Text(
        `${theme.fg("toolTitle", theme.bold(`${options.tmuxToolName} `))}${theme.fg("accent", action)}${theme.fg("muted", windowLabel)}`,
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme) {
      const render = getTmuxRenderDetails(result.details);
      if (!render) throw new Error("Missing tmux tool render details");

      return new Text(formatTmuxToolRenderText(render, expanded, theme), 0, 0);
    },
  });
};
