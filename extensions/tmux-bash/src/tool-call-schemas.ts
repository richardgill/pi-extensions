import { defineZodToolCall } from "@richardgill/pi-zod-tool-call";
import { z } from "zod";

type SchemaOptions = {
  bashToolName?: string;
  tmuxToolName?: string;
  defaultTimeoutSeconds: number;
  maxTimeoutSeconds: number;
  defaultPollInterval: number;
  pollContextLines: number;
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

const timeoutAction = z
  .enum(["kill", "background"])
  .optional()
  .describe('"kill" or "background" on timeout.');

const background = z.literal(true).describe("Return immediately and keep running in tmux.");

export const buildBashInputSchema = (options: SchemaOptions) =>
  z.union([
    z.object({
      command,
      name,
      background,
      timeout: timeout(options),
      timeoutAction,
      pollInterval: pollInterval(options),
      pollLines: pollLines(options),
    }),
    z.object({
      command,
      name,
      background: backgroundFalse,
      timeout: timeout(options),
      timeoutAction: z.literal("background").default("background"),
      pollInterval: pollInterval(options),
      pollLines: pollLines(options),
    }),
    z.object({
      command,
      name,
      background: backgroundFalse,
      timeout: timeout(options),
      timeoutAction: z.literal("kill"),
      pollInterval: pollInterval(options),
      pollLines: pollLines(options),
    }),
  ]);

export const buildTmuxInputSchema = (options: SchemaOptions) =>
  z.discriminatedUnion("action", [
    z.object({ action: tmuxAction("list") }),
    z.object({ action: tmuxAction("kill"), window: tmuxWindowId }),
    z.object({ action: tmuxAction("list-polls") }),
    z.object({ action: tmuxAction("peek"), window: tmuxWindowId }),
    z.object({
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
    z.object({ action: tmuxAction("unpoll"), window: tmuxWindowId }),
  ]);

export const buildBashToolCallSchema = <TInvalidResult>(
  options: SchemaOptions,
  invalidInput: InvalidInput<TInvalidResult>,
) =>
  defineZodToolCall({
    toolName: options.bashToolName ?? "bash",
    zodSchema: buildBashInputSchema(options),
    invalidInput,
  });

export const buildTmuxToolCallSchema = <TInvalidResult>(
  options: SchemaOptions,
  invalidInput: InvalidInput<TInvalidResult>,
) =>
  defineZodToolCall({
    toolName: options.tmuxToolName ?? "tmux",
    zodSchema: buildTmuxInputSchema(options),
    invalidInput,
  });

export type BashInput = z.infer<ReturnType<typeof buildBashInputSchema>>;
export type TmuxInput = z.infer<ReturnType<typeof buildTmuxInputSchema>>;
