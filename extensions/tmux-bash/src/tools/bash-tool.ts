import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ResolvedOptions } from "../config";
import {
  renderPromptTemplate,
  resolveSystemPromptToolSnippet,
  systemPromptGuidelines,
} from "../system-prompt";
import { runBashInTmux, toolError, type ExtensionState } from "../runtime";
import {
  renderBackgroundBashResultText,
  renderBashCallText,
  renderForegroundBashResultComponent,
  type TmuxBashToolDetails,
} from "../render";
import { buildBashToolCallSchema, type BashInput } from "../tool-call-schemas";

export type BashRenderState = {
  startedAt?: number;
  endedAt?: number;
  interval?: NodeJS.Timeout;
};

type ToolRenderContext<TState, TArgs> = {
  args: TArgs;
  state: TState;
  executionStarted: boolean;
  isError: boolean;
  invalidate: () => void;
};

const startBashRenderTiming = (context: ToolRenderContext<BashRenderState, Partial<BashInput>>) => {
  if (!context.executionStarted || context.state.startedAt !== undefined) return;

  context.state.startedAt = Date.now();
  context.state.endedAt = undefined;
};

const updateBashResultTiming = (
  context: ToolRenderContext<BashRenderState, Partial<BashInput>>,
  isPartial: boolean,
): void => {
  if (context.state.startedAt === undefined) context.state.startedAt = Date.now();

  if (isPartial && !context.state.interval) {
    context.state.interval = setInterval(() => context.invalidate(), 1000);
  }

  if (isPartial && !context.isError) return;

  if (context.state.endedAt === undefined) context.state.endedAt = Date.now();
  if (!context.state.interval) return;

  clearInterval(context.state.interval);
  context.state.interval = undefined;
};

const shouldRenderBashDuration = (
  args: Partial<BashInput>,
  details: TmuxBashToolDetails | undefined,
): boolean => args.background !== true && details?.outcome !== "timed-out-background";

export const registerBashTool = (
  pi: ExtensionAPI,
  state: ExtensionState,
  options: ResolvedOptions,
): void => {
  const bashToolCallSchema = buildBashToolCallSchema(options, toolError);

  pi.registerTool({
    name: options.bashToolName,
    label: options.bashToolName,
    description: renderPromptTemplate(options.bashToolDescription, options),
    promptSnippet: resolveSystemPromptToolSnippet(options.bashSystemPromptSnippet, options),
    promptGuidelines: systemPromptGuidelines(options),
    parameters: bashToolCallSchema.typeBoxSchema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return bashToolCallSchema.handleInput(params, (input) =>
        runBashInTmux(input, signal, onUpdate, pi, ctx, state, options),
      );
    },
    renderCall(args, theme, context) {
      startBashRenderTiming(context as ToolRenderContext<BashRenderState, Partial<BashInput>>);
      return new Text(renderBashCallText(args as Partial<BashInput>, theme), 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      const bashContext = context as ToolRenderContext<BashRenderState, Partial<BashInput>>;
      const content = result.content?.[0];
      const raw = content?.type === "text" ? content.text : "";
      const details = result.details as TmuxBashToolDetails | undefined;

      if (!shouldRenderBashDuration(bashContext.args, details)) {
        const renderDetails =
          details?.outcome === "timed-out-background" ? undefined : details?.render;
        return new Text(
          renderBackgroundBashResultText({
            raw,
            details: renderDetails,
            expanded,
            theme,
            options,
          }),
          0,
          0,
        );
      }

      updateBashResultTiming(bashContext, isPartial);
      return renderForegroundBashResultComponent({
        raw,
        details,
        expanded,
        isPartial,
        state: bashContext.state,
        theme,
        options,
      });
    },
  });
};
