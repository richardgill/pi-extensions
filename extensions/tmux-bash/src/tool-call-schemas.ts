import { defineZodToolCall } from "@richardgill/pi-zod-tool-call";
import { z } from "zod";

type SchemaOptions = {
  defaultTimeoutSeconds: number;
  maxTimeoutSeconds: number;
  defaultPollInterval: number;
  defaultPollLines: number;
};

type InvalidInput<TInvalidResult> = (message: string) => TInvalidResult;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const withDefaultTimeoutAction = (input: unknown): unknown => {
  if (!isRecord(input)) return input;
  if (input.background === true) return input;
  if (input.timeoutAction !== undefined) return input;
  return { ...input, timeoutAction: "background" };
};

const command = z.string().min(1).describe("Bash command to execute.");
const name = z.string().optional().describe("Optional tmux window name.");
const backgroundFalse = z.literal(false).optional();
const tmuxWindow = z
  .union([z.number().int(), z.string().min(1)])
  .describe("Window index/name. Required for poll/unpoll.");
const tmuxPeekWindow = z
  .union([z.literal("all"), z.number().int(), z.string().min(1)])
  .describe('Window index/name, or "all" for peek.');
const tmuxWindowId = z.string().min(1).describe("tmux #{window_id}, e.g. @123.");
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
    .default(options.defaultPollLines)
    .describe("Lines captured per check-in.");

const timeoutAction = z
  .enum(["kill", "background"])
  .optional()
  .describe('"kill" or "background" on timeout.');

const background = z.literal(true).describe("Return immediately and keep running in tmux.");

export const buildBashInputSchema = (options: SchemaOptions) => {
  const nonBackground = z.discriminatedUnion("timeoutAction", [
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

  return z.preprocess(
    withDefaultTimeoutAction,
    z.discriminatedUnion("background", [
      z.object({
        command,
        name,
        background,
        timeout: timeout(options),
        timeoutAction,
        pollInterval: pollInterval(options),
        pollLines: pollLines(options),
      }),
      nonBackground,
    ]),
  );
};

export const buildTmuxInputSchema = (options: SchemaOptions) =>
  z.discriminatedUnion("action", [
    z.object({ action: tmuxAction("list") }),
    z.object({ action: tmuxAction("kill"), window: tmuxWindowId }),
    z.object({ action: tmuxAction("list-polls") }),
    z.object({ action: tmuxAction("peek"), window: tmuxPeekWindow.optional() }),
    z.object({
      action: tmuxAction("poll"),
      window: tmuxWindow,
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
        .default(options.defaultPollLines)
        .describe("Lines captured per check-in."),
    }),
    z.object({ action: tmuxAction("unpoll"), window: tmuxWindow }),
  ]);

export const buildBashToolCallSchema = <TInvalidResult>(
  options: SchemaOptions,
  invalidInput: InvalidInput<TInvalidResult>,
) =>
  defineZodToolCall({
    toolName: "bash",
    zodSchema: buildBashInputSchema(options),
    invalidInput,
  });

export const buildTmuxToolCallSchema = <TInvalidResult>(
  options: SchemaOptions,
  invalidInput: InvalidInput<TInvalidResult>,
) =>
  defineZodToolCall({
    toolName: "tmux",
    zodSchema: buildTmuxInputSchema(options),
    invalidInput,
  });

export type BashInput = z.infer<ReturnType<typeof buildBashInputSchema>>;
export type TmuxInput = z.infer<ReturnType<typeof buildTmuxInputSchema>>;
