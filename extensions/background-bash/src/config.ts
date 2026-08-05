import { loadConfigOrDefault, templatedString } from "@richardgill/pi-config";
import { z } from "zod";

export const BACKGROUND_BASH_STATUS_KEY = "backgroundBashProcesses";

const DEFAULT_BASH_DESCRIPTION =
  'Execute a bash command. Output is truncated to Pi\'s standard limits. Defaults to a {{defaultTimeoutSeconds}}s timeout, max {{maxTimeoutSeconds}}s; timeoutAction defaults to "{{defaultTimeoutAction}}". Background processes report automatically when they finish.';
const DEFAULT_PROCESS_DESCRIPTION =
  "List, inspect, or kill background processes created by {{bashToolName}}.";
const DEFAULT_GUIDELINES = [
  "Use {{bashToolName}} with background: true for commands known to be long-running.",
  '{{bashToolName}} commands that exceed their timeout remain running when timeoutAction is "background".',
  "Background processes report automatically when they finish; do not repeatedly inspect them unless interim output is useful.",
  "Use {{processToolName}} list/peek/kill with the PGID returned by {{bashToolName}}.",
];

const templateVariables = [
  "bashToolName",
  "processToolName",
  "defaultTimeoutSeconds",
  "defaultTimeoutAction",
  "maxTimeoutSeconds",
];

const nonEmptyStringSchema = z.string().trim().min(1);
const positiveIntegerSchema = z.number().int().positive();
const promptTemplateSchema = templatedString({ variables: templateVariables }).trim().min(1);
const promptSnippetSchema = z.union([promptTemplateSchema, z.literal(false)]);

const timeoutOrderIsValid = (config: {
  defaultTimeoutSeconds?: number;
  maxTimeoutSeconds?: number;
}): boolean =>
  config.defaultTimeoutSeconds === undefined ||
  config.maxTimeoutSeconds === undefined ||
  config.defaultTimeoutSeconds <= config.maxTimeoutSeconds;

const buildOptionsSchema = () =>
  z
    .object({
      defaultTimeoutSeconds: positiveIntegerSchema.default(30),
      defaultTimeoutAction: z.enum(["background", "kill"]).default("background"),
      maxTimeoutSeconds: positiveIntegerSchema.default(60),
      outputDir: nonEmptyStringSchema.default("/tmp/pi-background-bash"),
      preserveOutputFiles: z.boolean().default(true),
      bashToolName: nonEmptyStringSchema.default("bash"),
      processToolName: nonEmptyStringSchema.default("bash_process"),
      bashToolDescription: promptTemplateSchema.default(DEFAULT_BASH_DESCRIPTION),
      processToolDescription: promptTemplateSchema.default(DEFAULT_PROCESS_DESCRIPTION),
      systemPrompt: z.boolean().default(true),
      bashSystemPromptSnippet: promptSnippetSchema.default(
        "Execute bash commands with automatic background handoff",
      ),
      processSystemPromptSnippet: promptSnippetSchema.default(
        "Inspect and control background bash processes",
      ),
      systemPromptGuidelines: z.array(promptTemplateSchema).default(() => [...DEFAULT_GUIDELINES]),
    })
    .refine(timeoutOrderIsValid, {
      message: "defaultTimeoutSeconds must be less than or equal to maxTimeoutSeconds",
    });

export const BackgroundBashOptionsSchema = buildOptionsSchema();
export const BackgroundBashConfigSchema = buildOptionsSchema();

export type BackgroundBashOptions = z.input<typeof BackgroundBashOptionsSchema>;
export type ResolvedOptions = z.infer<typeof BackgroundBashOptionsSchema>;

const renderTemplate = (template: string, options: ResolvedOptions): string => {
  const values = {
    bashToolName: options.bashToolName,
    processToolName: options.processToolName,
    defaultTimeoutSeconds: String(options.defaultTimeoutSeconds),
    defaultTimeoutAction: options.defaultTimeoutAction,
    maxTimeoutSeconds: String(options.maxTimeoutSeconds),
  };

  return Object.entries(values).reduce(
    (text, [name, value]) => text.replace(new RegExp(`{{\\s*${name}\\s*}}`, "g"), value),
    template,
  );
};

const renderSnippet = (value: string | false, options: ResolvedOptions): string | false =>
  value === false ? false : renderTemplate(value, options);

const resolveParsedOptions = (options: ResolvedOptions): ResolvedOptions => ({
  ...options,
  bashToolDescription: renderTemplate(options.bashToolDescription, options),
  processToolDescription: renderTemplate(options.processToolDescription, options),
  bashSystemPromptSnippet: renderSnippet(options.bashSystemPromptSnippet, options),
  processSystemPromptSnippet: renderSnippet(options.processSystemPromptSnippet, options),
  systemPromptGuidelines: options.systemPromptGuidelines.map((guideline) =>
    renderTemplate(guideline, options),
  ),
});

export const resolveOptions = (input: BackgroundBashOptions = {}): ResolvedOptions =>
  resolveParsedOptions(BackgroundBashOptionsSchema.parse(input));

export const DEFAULT_OPTIONS = resolveOptions();

export const loadBackgroundBashConfig = (): ResolvedOptions =>
  resolveOptions(
    loadConfigOrDefault({
      filename: "background-bash.jsonc",
      schema: BackgroundBashConfigSchema,
    }),
  );
