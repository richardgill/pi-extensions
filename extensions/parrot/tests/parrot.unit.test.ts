import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { findLastAssistantMessage, parrot, populateParrotInput } from "../src/extension";

const messageEntry = (role: string, content: unknown[]): SessionEntry =>
  ({
    type: "message",
    id: Math.random().toString(),
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role, content, timestamp: Date.now() },
  }) as SessionEntry;

const createCtx = (branch: SessionEntry[], hasUI = true) => {
  const notifications: { message: string; level: string }[] = [];
  const editorTexts: string[] = [];
  const ctx = {
    hasUI,
    sessionManager: { getBranch: () => branch },
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      setEditorText: (text: string) => editorTexts.push(text),
    },
  } as unknown as ExtensionContext;

  return { ctx, notifications, editorTexts };
};

describe("findLastAssistantMessage", () => {
  it("returns the visible text from the latest assistant message", () => {
    const entries = [
      messageEntry("assistant", [{ type: "text", text: "old" }]),
      messageEntry("user", [{ type: "text", text: "ignore" }]),
      messageEntry("assistant", [
        { type: "thinking", thinking: "hidden" },
        { type: "text", text: "new" },
        { type: "text", text: "again" },
      ]),
    ];

    expect(findLastAssistantMessage(entries)).toBe("new\n\nagain");
  });

  it("skips assistant messages with no visible text", () => {
    const entries = [
      messageEntry("assistant", [{ type: "text", text: "visible" }]),
      messageEntry("assistant", [{ type: "toolCall", name: "read", arguments: {} }]),
    ];

    expect(findLastAssistantMessage(entries)).toBe("visible");
  });
});

describe("populateParrotInput", () => {
  it("sets the editor text instead of sending a message", () => {
    const { ctx, editorTexts } = createCtx([
      messageEntry("assistant", [{ type: "text", text: "copy me" }]),
    ]);

    populateParrotInput(ctx);

    expect(editorTexts).toEqual(["copy me"]);
  });

  it("notifies when no assistant text exists", () => {
    const { ctx, notifications, editorTexts } = createCtx([
      messageEntry("user", [{ type: "text", text: "hello" }]),
    ]);

    populateParrotInput(ctx);

    expect(editorTexts).toEqual([]);
    expect(notifications).toEqual([{ message: "No assistant messages found", level: "error" }]);
  });
});

describe("parrot", () => {
  it("registers the parrot command and configured shortcut", () => {
    const commands: string[] = [];
    const shortcuts: string[] = [];
    const pi = {
      registerCommand: (name: string) => commands.push(name),
      registerShortcut: (shortcut: string) => shortcuts.push(shortcut),
    } as unknown as ExtensionAPI;

    parrot({ keyboardShortcut: "ctrl+r" })(pi);

    expect(commands).toEqual(["parrot"]);
    expect(shortcuts).toEqual(["ctrl+r"]);
  });

  it("can disable the shortcut", () => {
    const commands: string[] = [];
    const shortcuts: string[] = [];
    const pi = {
      registerCommand: (name: string) => commands.push(name),
      registerShortcut: (shortcut: string) => shortcuts.push(shortcut),
    } as unknown as ExtensionAPI;

    parrot({ keyboardShortcut: false })(pi);

    expect(commands).toEqual(["parrot"]);
    expect(shortcuts).toEqual([]);
  });
});
