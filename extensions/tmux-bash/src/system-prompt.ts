import { tmuxWindowAttachCommand } from "./tmux-utils";
import { DEFAULT_SYSTEM_PROMPT_GUIDELINES, type ResolvedOptions, type TmuxAction } from "./config";

const replaceTemplateVariable = (template: string, variable: string, value: string): string =>
  template.replace(new RegExp(`{{\\s*${variable}\\s*}}`, "g"), value);

export const renderPromptTemplate = (template: string, options: ResolvedOptions): string => {
  const variables = {
    attachCommand: tmuxWindowAttachCommand("@123", process.env, options.tmuxBinary),
    bashContextLines: String(options.bashContextLines),
    bashToolName: options.bashToolName,
    defaultTimeoutAction: options.defaultTimeoutAction,
    defaultTimeoutSeconds: String(options.defaultTimeoutSeconds),
    maxOutputKb: String(options.maxOutputBytes / 1024),
    maxTimeoutSeconds: String(options.maxTimeoutSeconds),
    tmuxToolName: options.tmuxToolName,
  };

  return Object.entries(variables).reduce(
    (text, [variable, value]) => replaceTemplateVariable(text, variable, value),
    template,
  );
};

export const resolveSystemPromptToolSnippet = (
  snippet: string | false,
  options: ResolvedOptions,
): string | undefined => {
  if (!options.systemPrompt || snippet === false) return undefined;

  return renderPromptTemplate(snippet, options);
};

const enabledTmuxActions = (actions: readonly TmuxAction[], candidates: TmuxAction[]): string =>
  candidates.filter((action) => actions.includes(action)).join("/");

const resolveDefaultGuideline = (
  guideline: string,
  options: ResolvedOptions,
): string | undefined => {
  if (guideline === DEFAULT_SYSTEM_PROMPT_GUIDELINES[2] && !options.bashPollIntervalEnabled) {
    return undefined;
  }
  if (guideline === DEFAULT_SYSTEM_PROMPT_GUIDELINES[3]) {
    return options.tmuxEnabledActions.includes("list") ? guideline : undefined;
  }
  if (guideline === DEFAULT_SYSTEM_PROMPT_GUIDELINES[4]) {
    const actions = enabledTmuxActions(options.tmuxEnabledActions, [
      "peek",
      "kill",
      "poll",
      "unpoll",
    ]);
    return actions
      ? `Use {{tmuxToolName}} ${actions} with a stable #{window_id} like @123.`
      : undefined;
  }
  if (guideline === DEFAULT_SYSTEM_PROMPT_GUIDELINES[6]) {
    const actions = enabledTmuxActions(options.tmuxEnabledActions, ["poll", "unpoll"]);
    return actions
      ? `Use {{tmuxToolName}} ${actions} to start or stop periodic check-ins for an existing background window.`
      : undefined;
  }

  return guideline;
};

const resolveGuideline = (guideline: string, options: ResolvedOptions): string | undefined => {
  const resolved = resolveDefaultGuideline(guideline, options);
  return resolved === undefined ? undefined : renderPromptTemplate(resolved, options);
};

export const systemPromptGuidelines = (options: ResolvedOptions): string[] => {
  if (!options.systemPrompt) return [];

  return options.systemPromptGuidelines.flatMap((guideline) => {
    const resolved = resolveGuideline(guideline, options);
    return resolved === undefined ? [] : [resolved];
  });
};
