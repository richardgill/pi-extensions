import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";

export type ParrotOptions = {
  keyboardShortcut?: KeyId | false;
};

export type ParrotConfig = {
  keyboardShortcut: KeyId | false;
};

export const DEFAULT_OPTIONS: ParrotConfig = {
  keyboardShortcut: "alt+r",
};

export const PARROT_DESCRIPTION = "Populate the input box with the last assistant message";

const assistantText = (entry: SessionEntry): string | undefined => {
  if (entry.type !== "message" || entry.message.role !== "assistant") return undefined;

  const textParts = entry.message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text);

  return textParts.length > 0 ? textParts.join("\n\n") : undefined;
};

export const findLastAssistantMessage = (entries: SessionEntry[]): string | undefined =>
  [...entries].reverse().map(assistantText).find(Boolean);

export const populateParrotInput = (ctx: ExtensionContext): void => {
  if (!ctx.hasUI) return;

  const lastAssistantText = findLastAssistantMessage(ctx.sessionManager.getBranch());
  if (!lastAssistantText) {
    ctx.ui.notify("No assistant messages found", "error");
    return;
  }

  ctx.ui.setEditorText(lastAssistantText);
};

export const parrot = (options: ParrotOptions = {}) => {
  const config = { ...DEFAULT_OPTIONS, ...options };

  return (pi: ExtensionAPI): void => {
    if (config.keyboardShortcut) {
      pi.registerShortcut(config.keyboardShortcut, {
        description: PARROT_DESCRIPTION,
        handler: async (ctx) => {
          populateParrotInput(ctx);
        },
      });
    }

    pi.registerCommand("parrot", {
      description: PARROT_DESCRIPTION,
      handler: async (_args, ctx) => {
        populateParrotInput(ctx);
      },
    });
  };
};
