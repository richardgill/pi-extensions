import { tmuxWindowAttachCommand } from "./tmux-utils";
import type { ResolvedOptions } from "./config";

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

export const systemPromptGuidelines = (options: ResolvedOptions): string[] => {
  if (!options.systemPrompt) return [];

  return options.systemPromptGuidelines.map((guideline) =>
    renderPromptTemplate(guideline, options),
  );
};
