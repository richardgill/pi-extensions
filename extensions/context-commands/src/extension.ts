import os from "node:os";
import path from "node:path";

import {
  formatSize,
  type ExecResult,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { z } from "zod";

const CUSTOM_MESSAGE_TYPE = "context-command";
const CommandNameSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
    "must contain lowercase letters, numbers, and single hyphens",
  );
const ContextCommandSchema = z
  .object({
    name: CommandNameSchema,
    description: z.string().trim().min(1),
    command: z.string().trim().min(1),
    commandArgs: z.array(z.string()).default([]),
    title: z.string().trim().min(1).optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

export const ContextCommandsConfigSchema = z
  .object({
    commands: z.array(ContextCommandSchema).default([]),
  })
  .strict()
  .refine(
    (config) =>
      new Set(config.commands.map((command) => command.name)).size === config.commands.length,
    { message: "command names must be unique", path: ["commands"] },
  );

export type ContextCommandsOptions = z.input<typeof ContextCommandsConfigSchema>;
type ContextCommand = z.output<typeof ContextCommandSchema>;
type ContextMessageDetails = { summary: string };

const expandExecutable = (command: string): string =>
  command.startsWith("~/") ? path.join(os.homedir(), command.slice(2)) : command;

const formatContext = (command: ContextCommand, result: ExecResult): string =>
  [
    `# ${command.title ?? `/${command.name} context`}`,
    "## stdout",
    result.stdout || "(empty)",
    "## stderr",
    result.stderr || "(empty)",
  ].join("\n\n");

const notifyProcessFailure = (
  command: ContextCommand,
  result: ExecResult,
  ctx: ExtensionCommandContext,
): void => {
  const reason = result.killed ? "timed out or was killed" : `exited with code ${result.code}`;
  const stderr = result.stderr.trim();
  ctx.ui.notify(`/${command.name} failed: ${reason}${stderr ? `: ${stderr}` : ""}`, "error");
};

const runContextCommand = async (
  pi: ExtensionAPI,
  command: ContextCommand,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> => {
  if (!ctx.isIdle()) {
    ctx.ui.notify(`/${command.name} cannot run while Pi is busy`, "warning");
    return;
  }

  let result: ExecResult;
  try {
    result = await pi.exec(expandExecutable(command.command), command.commandArgs, {
      cwd: ctx.cwd,
      timeout: command.timeoutMs,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`/${command.name} failed: ${message}`, "error");
    return;
  }

  if (result.killed || result.code !== 0) {
    notifyProcessFailure(command, result, ctx);
    return;
  }

  const bytes = Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
  pi.sendMessage<ContextMessageDetails>({
    customType: CUSTOM_MESSAGE_TYPE,
    content: formatContext(command, result),
    display: true,
    details: { summary: `/${command.name} loaded ${formatSize(bytes)} into context` },
  });

  if (args.trim()) pi.sendUserMessage(args);
};

export const contextCommands = (input: ContextCommandsOptions = {}) => {
  const options = ContextCommandsConfigSchema.parse(input);

  return (pi: ExtensionAPI): void => {
    pi.registerMessageRenderer<ContextMessageDetails>(
      CUSTOM_MESSAGE_TYPE,
      (message, _options, theme) =>
        new Text(
          theme.fg("customMessageLabel", message.details?.summary ?? "Context loaded"),
          0,
          0,
        ),
    );

    options.commands.forEach((command) => {
      pi.registerCommand(command.name, {
        description: command.description,
        handler: async (args, ctx) => runContextCommand(pi, command, args, ctx),
      });
    });
  };
};
