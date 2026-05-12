import { defineZodToolCall } from "@richardgill/pi-zod-tool-call";
import { z } from "zod";

type SchemaOptions = {
  defaultTimeoutSeconds: number;
  maxTimeoutSeconds: number;
  defaultPollInterval: number;
  defaultPollLines: number;
};

type InvalidInput<TInvalidResult> = (message: string) => TInvalidResult;

const command = z.string().min(1).describe("Bash command to run in a background tmux window.");
const name = z.string().optional().describe("Optional tmux window name.");
const backgroundFalse = z.literal(false).optional();
const tmuxWindow = z
  .union([z.number().int(), z.string().min(1)])
  .describe(
    "Window index, name, or 'all' (peek only). Required for poll/unpoll. Optional for attach/peek.",
  );
const tmuxPeekWindow = z
  .union([z.literal("all"), z.number().int(), z.string().min(1)])
  .describe(
    "Window index, name, or 'all' (peek only). Required for poll/unpoll. Optional for attach/peek.",
  );
const tmuxAction = <TAction extends string>(action: TAction) =>
  z.literal(action).describe("Which tmux action to perform.");

const timeout = (options: SchemaOptions) =>
  z
    .number()
    .int()
    .positive()
    .max(options.maxTimeoutSeconds)
    .default(options.defaultTimeoutSeconds)
    .describe(
      "Seconds to wait before applying timeoutAction. Ignored when background is true. Defaults/clamps according to extension config.",
    );

const pollInterval = (options: SchemaOptions) =>
  z
    .number()
    .int()
    .nonnegative()
    .default(options.defaultPollInterval)
    .describe(
      "Seconds between automatic output check-ins. Only used with background:true or timeoutAction:'background'.",
    );

const pollLines = (options: SchemaOptions) =>
  z
    .number()
    .int()
    .positive()
    .default(options.defaultPollLines)
    .describe("Scrollback lines captured per poll.");

const timeoutAction = z
  .enum(["kill", "background"])
  .optional()
  .describe(
    "What to do when the timeout is reached. 'kill' (default) kills the tmux window; 'background' leaves the command running in tmux. Use 'background' with pollInterval to keep getting check-ins after the timeout.",
  );

const background = z
  .literal(true)
  .describe(
    "If true, start the command in tmux and return immediately. Use for servers, watchers, REPLs, or anything expected to run longer than the timeout. timeout/timeoutAction are ignored when true. Pair with pollInterval for check-ins.",
  );

export const buildBashInputSchema = (options: SchemaOptions) => {
  const nonBackground = z.discriminatedUnion("timeoutAction", [
    z.object({
      command,
      name,
      background: backgroundFalse,
      timeout: timeout(options),
      timeoutAction: z.literal("background"),
      pollInterval: pollInterval(options),
      pollLines: pollLines(options),
    }),
    z.object({
      command,
      name,
      background: backgroundFalse,
      timeout: timeout(options),
      timeoutAction: z.literal("kill").optional(),
      pollInterval: pollInterval(options),
      pollLines: pollLines(options),
    }),
  ]);

  return z.discriminatedUnion("background", [
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
  ]);
};

export const buildTmuxInputSchema = (options: SchemaOptions) =>
  z.discriminatedUnion("action", [
    z.object({ action: tmuxAction("list") }),
    z.object({ action: tmuxAction("kill") }),
    z.object({ action: tmuxAction("list-polls") }),
    z.object({ action: tmuxAction("attach"), window: tmuxWindow.optional() }),
    z.object({ action: tmuxAction("peek"), window: tmuxPeekWindow.optional() }),
    z.object({
      action: tmuxAction("poll"),
      window: tmuxWindow,
      pollInterval: z
        .number()
        .int()
        .nonnegative()
        .default(options.defaultPollInterval)
        .describe("Seconds between automatic output check-ins (poll action)."),
      pollLines: z
        .number()
        .int()
        .positive()
        .default(options.defaultPollLines)
        .describe("Scrollback lines captured per poll (poll action)."),
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
