import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import thinkingToggle from "../src/index";

describe("thinking toggle", () => {
  it("cycles medium, high, and xhigh", async () => {
    let level = "medium";
    let command: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
    const notify = vi.fn();
    const pi = {
      getThinkingLevel: () => level,
      setThinkingLevel: (next: string) => {
        level = next;
      },
      registerShortcut: vi.fn(),
      registerCommand: (_name: string, options: { handler: typeof command }) => {
        command = options.handler;
      },
    } as unknown as ExtensionAPI;
    const ctx = { ui: { notify } } as unknown as ExtensionCommandContext;

    thinkingToggle(pi);
    await command?.("", ctx);
    expect(level).toBe("high");
    await command?.("", ctx);
    expect(level).toBe("xhigh");
    await command?.("", ctx);
    expect(level).toBe("medium");
    expect(notify).toHaveBeenCalledTimes(3);
  });
});
