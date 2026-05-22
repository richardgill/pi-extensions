import { tmuxWindowAttachCommand } from "./tmux-utils";
import type { ResolvedOptions } from "./options";

const replaceTemplateVariable = (template: string, variable: string, value: string): string =>
  template.replace(new RegExp(`{{\\s*${variable}\\s*}}`, "g"), value);

export const renderPromptTemplate = (template: string, options: ResolvedOptions): string => {
  const variables = {
    attachCommand: tmuxWindowAttachCommand("@123", process.env, options.tmuxBinary),
    bashContextLines: String(options.bashContextLines),
    bashTool: options.bashToolName,
    defaultTimeoutSeconds: String(options.defaultTimeoutSeconds),
    maxOutputKb: String(options.maxOutputBytes / 1024),
    maxTimeoutSeconds: String(options.maxTimeoutSeconds),
    tmuxTool: options.tmuxToolName,
  };

  return Object.entries(variables).reduce(
    (text, [variable, value]) => replaceTemplateVariable(text, variable, value),
    template,
  );
};

const configuredSystemPromptToolSnippet = (
  toolName: string,
  options: ResolvedOptions,
): string | false | undefined => {
  const toolSnippets = options.systemPromptToolSnippets;
  if (Object.prototype.hasOwnProperty.call(toolSnippets, toolName)) {
    return toolSnippets[toolName];
  }
  return undefined;
};

export const resolveSystemPromptToolSnippet = (
  toolName: string,
  defaultSnippet: string,
  options: ResolvedOptions,
): string | undefined => {
  if (!options.systemPrompt) return undefined;

  const value = configuredSystemPromptToolSnippet(toolName, options);
  if (value === false) return undefined;
  return renderPromptTemplate(value ?? defaultSnippet, options);
};

export const systemPromptGuidelines = (options: ResolvedOptions): string[] => {
  if (!options.systemPrompt) return [];

  const guidelines = options.systemPromptGuidelines;
  if (guidelines === false) return [];
  return guidelines.map((guideline) => renderPromptTemplate(guideline, options));
};
