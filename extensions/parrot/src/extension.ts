import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { resolveOptions, type ParrotOptions, type ResolvedOptions } from "./config";

export {
  DEFAULT_OPTIONS,
  ParrotConfigSchema,
  ParrotOptionsSchema,
  type ParrotOptions,
} from "./config";

export const PARROT_DESCRIPTION = "Populate the input box with the last assistant message";

type EditorResult = {
  content: string | null;
  error: string | null;
  exitCode: number | null;
};

const assistantText = (entry: SessionEntry): string | undefined => {
  if (entry.type !== "message" || entry.message.role !== "assistant") return undefined;

  const textParts = entry.message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text);

  return textParts.length > 0 ? textParts.join("\n\n") : undefined;
};

export const findLastAssistantMessage = (entries: SessionEntry[]): string | undefined =>
  [...entries].reverse().map(assistantText).find(Boolean);

export const getEditorCommand = (): string => process.env.VISUAL || process.env.EDITOR || "";

const clearScreen = (): void => {
  process.stdout.write("\x1b[2J\x1b[H");
};

export const runEditor = (filePath: string): EditorResult => {
  clearScreen();

  const editorCommand = getEditorCommand();
  if (!editorCommand) {
    return {
      content: null,
      error: "No editor configured. Set $VISUAL or $EDITOR environment variable.",
      exitCode: null,
    };
  }

  const result = spawnSync(editorCommand, [filePath], {
    stdio: "inherit",
    env: process.env,
    shell: true,
  });
  const error =
    result.error?.message ?? (result.signal ? `Killed by signal: ${result.signal}` : null);
  if (error) return { content: null, error, exitCode: result.status };

  try {
    return {
      content: fs.readFileSync(filePath, "utf8").replace(/\n$/, ""),
      error: null,
      exitCode: result.status,
    };
  } catch (readError) {
    const message = readError instanceof Error ? readError.message : String(readError);
    return {
      content: null,
      error: `Could not read edited file: ${message}`,
      exitCode: result.status,
    };
  }
};

const removeTempFile = (filePath: string, ctx: ExtensionContext): void => {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Failed to delete ${filePath}: ${message}`, "error");
  }
};

const openExternalEditor = async (
  content: string,
  ctx: ExtensionContext,
): Promise<EditorResult> => {
  const tempFile = path.join(os.tmpdir(), `pi-parrot-${Date.now()}.md`);
  fs.writeFileSync(tempFile, content, "utf8");

  return ctx.ui.custom<EditorResult>((tui, _theme, _keybindings, done) => {
    tui.stop();
    const result = runEditor(tempFile);
    tui.start();
    tui.requestRender(true);
    removeTempFile(tempFile, ctx);
    done(result);
    return { render: () => [], invalidate: () => undefined } as never;
  });
};

export const applyParrotContent = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  content: string,
  options: Pick<ResolvedOptions, "sendAfterEditorClose">,
): void => {
  if (!content) {
    ctx.ui.notify("No message to send", "info");
    return;
  }

  if (!options.sendAfterEditorClose) {
    ctx.ui.setEditorText(content);
    return;
  }

  if (ctx.isIdle()) {
    pi.sendUserMessage(content);
    return;
  }

  pi.sendUserMessage(content, { deliverAs: "steer" });
};

export const handleEditorResult = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  result: EditorResult,
  options: Pick<ResolvedOptions, "sendAfterEditorClose">,
): void => {
  if (result.error) {
    ctx.ui.notify(`Editor error: ${result.error}`, "error");
    return;
  }

  if (result.exitCode !== null && result.exitCode !== 0) {
    ctx.ui.notify(
      `'${getEditorCommand()}' exited with code ${result.exitCode}. Not sending message`,
      "warning",
    );
    return;
  }

  applyParrotContent(pi, ctx, result.content ?? "", options);
};

export const handleParrot = async (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  options: ResolvedOptions,
): Promise<void> => {
  if (!ctx.hasUI) return;

  const lastAssistantText = findLastAssistantMessage(ctx.sessionManager.getBranch());
  if (!lastAssistantText) {
    ctx.ui.notify("No assistant messages found", "error");
    return;
  }

  if (!options.openExternalEditor) {
    ctx.ui.setEditorText(lastAssistantText);
    return;
  }

  handleEditorResult(pi, ctx, await openExternalEditor(lastAssistantText, ctx), options);
};

export const populateParrotInput = (ctx: ExtensionContext): void => {
  if (!ctx.hasUI) return;

  const lastAssistantText = findLastAssistantMessage(ctx.sessionManager.getBranch());
  if (!lastAssistantText) {
    ctx.ui.notify("No assistant messages found", "error");
    return;
  }

  ctx.ui.setEditorText(lastAssistantText);
};

export const parrot = (input: ParrotOptions = {}) => {
  const options = resolveOptions(input);

  return (pi: ExtensionAPI): void => {
    if (options.keyboardShortcut) {
      pi.registerShortcut(options.keyboardShortcut, {
        description: PARROT_DESCRIPTION,
        handler: async (ctx) => {
          await handleParrot(pi, ctx, options);
        },
      });
    }

    pi.registerCommand("parrot", {
      description: PARROT_DESCRIPTION,
      handler: async (_args, ctx) => {
        await handleParrot(pi, ctx, options);
      },
    });
  };
};
