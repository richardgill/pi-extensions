import { defineZodToolCall } from "@richardgill/pi-zod-tool-call";
import { z } from "zod";
import type { TmuxAction } from "./config";

type SchemaOptions = {
  bashToolName: string;
  tmuxToolName: string;
  defaultTimeoutSeconds: number;
  defaultTimeoutAction: "kill" | "background";
  maxTimeoutSeconds: number;
  defaultPollInterval: number;
  pollContextLines: number;
  tmuxEnabledActions: readonly TmuxAction[];
  bashPollIntervalEnabled: boolean;
};

type InvalidInput<TInvalidResult> = (message: string) => TInvalidResult;

const command = z.string().min(1).describe("Bash command to execute.");
const name = z.string().optional().describe("Optional tmux window name.");
const backgroundFalse = z.literal(false).optional();
const tmuxWindowId = z
  .string()
  .regex(/^@\d+$/)
  .describe("tmux #{window_id}, e.g. @123.");
const tmuxAction = <TAction extends string>(action: TAction) =>
  z.literal(action).describe("tmux action.");

const timeout = (options: SchemaOptions) =>
  z
    .number()
    .int()
    .positive()
    .max(options.maxTimeoutSeconds)
    .default(options.defaultTimeoutSeconds)
    .describe("Seconds before timeoutAction.");

const pollInterval = (options: SchemaOptions) =>
  z
    .number()
    .int()
    .nonnegative()
    .default(options.defaultPollInterval)
    .describe("Seconds between background check-ins.");

const pollLines = (options: SchemaOptions) =>
  z
    .number()
    .int()
    .positive()
    .default(options.pollContextLines)
    .describe("Lines captured per check-in.");

const backgroundTimeoutAction = z
  .enum(["kill", "background"])
  .optional()
  .describe('"kill" or "background" on timeout.');

const foregroundTimeoutAction = (options: SchemaOptions) =>
  z
    .enum(["kill", "background"])
    .default(options.defaultTimeoutAction)
    .describe('"kill" or "background" on timeout.');

const background = z.literal(true).describe("Return immediately and keep running in tmux.");

const bashPollProperties = (options: SchemaOptions) =>
  options.bashPollIntervalEnabled
    ? { pollInterval: pollInterval(options), pollLines: pollLines(options) }
    : {};

type BackgroundBashInput = {
  command: string;
  name?: string;
  background: true;
  timeout: number;
  timeoutAction?: "kill" | "background";
  pollInterval?: number;
  pollLines?: number;
};

type ForegroundBashInput = {
  command: string;
  name?: string;
  background?: false;
  timeout: number;
  timeoutAction: "kill" | "background";
  pollInterval?: number;
  pollLines?: number;
};

export type BashInput = BackgroundBashInput | ForegroundBashInput;

export type TmuxInput =
  | { action: "list" }
  | { action: "kill"; window: string }
  | { action: "list-polls" }
  | { action: "peek"; window: string }
  | { action: "poll"; window: string; pollInterval: number; pollLines: number }
  | { action: "unpoll"; window: string };

const buildBashInputSchema = (options: SchemaOptions): z.ZodType<BashInput> => {
  const pollProperties = bashPollProperties(options);

  return z.union([
    z.object({
      command,
      name,
      background,
      timeout: timeout(options),
      timeoutAction: backgroundTimeoutAction,
      ...pollProperties,
    }),
    z.object({
      command,
      name,
      background: backgroundFalse,
      timeout: timeout(options),
      timeoutAction: foregroundTimeoutAction(options),
      ...pollProperties,
    }),
  ]) as unknown as z.ZodType<BashInput>;
};

const tmuxInputSchemas = (options: SchemaOptions) => ({
  list: z.object({ action: tmuxAction("list") }),
  kill: z.object({ action: tmuxAction("kill"), window: tmuxWindowId }),
  "list-polls": z.object({ action: tmuxAction("list-polls") }),
  peek: z.object({ action: tmuxAction("peek"), window: tmuxWindowId }),
  poll: z.object({
    action: tmuxAction("poll"),
    window: tmuxWindowId,
    pollInterval: z
      .number()
      .int()
      .nonnegative()
      .default(options.defaultPollInterval)
      .describe("Seconds between check-ins."),
    pollLines: z
      .number()
      .int()
      .positive()
      .default(options.pollContextLines)
      .describe("Lines captured per check-in."),
  }),
  unpoll: z.object({ action: tmuxAction("unpoll"), window: tmuxWindowId }),
});

const buildTmuxInputSchema = (options: SchemaOptions): z.ZodType<TmuxInput> => {
  const schemas = tmuxInputSchemas(options);
  const enabledSchemas = options.tmuxEnabledActions.map((action) => schemas[action]);
  const [firstSchema, ...remainingSchemas] = enabledSchemas;

  if (!firstSchema) return z.never() as z.ZodType<TmuxInput>;
  if (remainingSchemas.length === 0) return firstSchema as z.ZodType<TmuxInput>;

  return z.discriminatedUnion("action", [firstSchema, ...remainingSchemas]) as z.ZodType<TmuxInput>;
};

export const buildBashToolCallSchema = <TInvalidResult>(
  options: SchemaOptions,
  invalidInput: InvalidInput<TInvalidResult>,
) =>
  defineZodToolCall({
    toolName: options.bashToolName,
    zodSchema: buildBashInputSchema(options),
    invalidInput,
  });

export const buildTmuxToolCallSchema = <TInvalidResult>(
  options: SchemaOptions,
  invalidInput: InvalidInput<TInvalidResult>,
) =>
  defineZodToolCall({
    toolName: options.tmuxToolName,
    zodSchema: buildTmuxInputSchema(options),
    invalidInput,
  });
