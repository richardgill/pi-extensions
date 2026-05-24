import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
  applyParrotContent,
  findLastAssistantMessage,
  handleEditorResult,
  parrot,
  populateParrotInput,
} from "../src/extension";

const messageEntry = (role: string, content: unknown[]): SessionEntry =>
  ({
    type: "message",
    id: Math.random().toString(),
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role, content, timestamp: Date.now() },
  }) as SessionEntry;

const createCtx = (branch: SessionEntry[], hasUI = true, idle = true) => {
  const notifications: { message: string; level: string }[] = [];
  const editorTexts: string[] = [];
  const ctx = {
    hasUI,
    isIdle: () => idle,
    sessionManager: { getBranch: () => branch },
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      setEditorText: (text: string) => editorTexts.push(text),
    },
  } as unknown as ExtensionContext;

  return { ctx, notifications, editorTexts };
};

const createPi = () => {
  const userMessages: { content: string; options?: unknown }[] = [];
  const pi = {
    sendUserMessage: (content: string, options?: unknown) =>
      userMessages.push({ content, options }),
  } as unknown as ExtensionAPI;

  return { pi, userMessages };
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

describe("editor result handling", () => {
  it("places edited content in the editor by default", () => {
    const { ctx, editorTexts } = createCtx([]);
    const { pi, userMessages } = createPi();

    handleEditorResult(
      pi,
      ctx,
      { content: "edited", error: null, exitCode: 0 },
      { sendAfterEditorClose: false },
    );

    expect(editorTexts).toEqual(["edited"]);
    expect(userMessages).toEqual([]);
  });

  it("can submit edited content after the external editor closes", () => {
    const { ctx, editorTexts } = createCtx([]);
    const { pi, userMessages } = createPi();

    applyParrotContent(pi, ctx, "edited", { sendAfterEditorClose: true });

    expect(editorTexts).toEqual([]);
    expect(userMessages).toEqual([{ content: "edited", options: undefined }]);
  });

  it("uses steering delivery when submitting while busy", () => {
    const { ctx } = createCtx([], true, false);
    const { pi, userMessages } = createPi();

    applyParrotContent(pi, ctx, "edited", { sendAfterEditorClose: true });

    expect(userMessages).toEqual([{ content: "edited", options: { deliverAs: "steer" } }]);
  });

  it("reports external editor errors", () => {
    const { ctx, notifications } = createCtx([]);
    const { pi } = createPi();

    handleEditorResult(
      pi,
      ctx,
      { content: null, error: "no editor", exitCode: null },
      { sendAfterEditorClose: false },
    );

    expect(notifications).toEqual([{ message: "Editor error: no editor", level: "error" }]);
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
