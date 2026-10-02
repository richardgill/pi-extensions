import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it as testCases, vi } from "vitest";
import { type Preset, preset } from "../src/extension";

const strong: Preset = {
  provider: "openai",
  model: "gpt-6.1-sol",
  thinkingLevel: "high",
};
const xstrong: Preset = { ...strong, model: "gpt-6-astra" };
const originalTools = ["read", "bash", "edit", "write", "codemode"];

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown>;

const createHarness = ({
  presets = { strong, xstrong },
  flag,
  savedName,
}: {
  presets?: Record<string, Preset>;
  flag?: string;
  savedName?: string;
} = {}) => {
  const handlers = new Map<string, Handler>();
  const shortcuts = new Map<string, { handler: (ctx: ExtensionContext) => Promise<void> }>();
  const model = { provider: "openai", id: "gpt-6.1-sol" } as Model<Api>;
  const ui = {
    notify: vi.fn(),
    setStatus: vi.fn(),
    theme: { fg: (_color: string, text: string) => text },
  };
  const ctx = {
    model,
    modelRegistry: {
      find: (provider: string, id: string) => ({ provider, id }),
    },
    sessionManager: {
      getEntries: () =>
        savedName
          ? [{ type: "custom", customType: "preset-state", data: { name: savedName } }]
          : [],
    },
    ui,
  } as unknown as ExtensionContext;
  const api = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerFlag: vi.fn(),
    registerCommand: vi.fn(),
    registerShortcut: (
      key: string,
      options: { handler: (ctx: ExtensionContext) => Promise<void> },
    ) => shortcuts.set(key, options),
    getFlag: () => flag,
    getThinkingLevel: vi.fn(() => "high"),
    getActiveTools: vi.fn(() => [...originalTools]),
    getAllTools: () => originalTools.map((name) => ({ name })),
    setModel: vi.fn(async () => true),
    setThinkingLevel: vi.fn(),
    setActiveTools: vi.fn(),
    appendEntry: vi.fn(),
  };
  preset({ presets, cycleShortcut: "ctrl+p" })(api as unknown as ExtensionAPI);
  return { api, ctx, handlers, shortcuts, ui };
};

type Harness = ReturnType<typeof createHarness>;
const start = (harness: Harness) => harness.handlers.get("session_start")!({}, harness.ctx);
const cycle = (harness: Harness) => harness.shortcuts.get("ctrl+p")!.handler(harness.ctx);

const expectNoSettingsChanged = ({ api }: Harness) => {
  expect(api.setModel).not.toHaveBeenCalled();
  expect(api.setThinkingLevel).not.toHaveBeenCalled();
  expect(api.setActiveTools).not.toHaveBeenCalled();
};

describe("preset startup recognition", () => {
  testCases(
    "recognizes strong without reapplying settings, then cycles straight to xstrong",
    async () => {
      const harness = createHarness();
      await start(harness);

      expect(harness.ui.setStatus).toHaveBeenLastCalledWith("preset", "preset:strong");
      expect(harness.ui.notify).not.toHaveBeenCalled();
      expectNoSettingsChanged(harness);

      await cycle(harness);
      expect(harness.api.setModel).toHaveBeenCalledExactlyOnceWith({
        provider: "openai",
        id: "gpt-6-astra",
      });
      expect(harness.ui.setStatus).toHaveBeenLastCalledWith("preset", "preset:xstrong");
    },
  );

  testCases(
    "clearing after cycling restores the original model, thinking, and custom tools",
    async () => {
      const harness = createHarness({
        presets: { strong, xstrong: { ...xstrong, thinkingLevel: "xhigh", tools: ["read"] } },
      });
      await start(harness);
      await cycle(harness);
      await cycle(harness);

      expect(harness.api.setModel).toHaveBeenLastCalledWith(harness.ctx.model);
      expect(harness.api.setThinkingLevel).toHaveBeenLastCalledWith("high");
      expect(harness.api.setActiveTools).toHaveBeenLastCalledWith(originalTools);
      expect(harness.ui.setStatus).toHaveBeenLastCalledWith("preset", undefined);
    },
  );

  testCases.each<{ name: string; candidate: Preset; matches: boolean }>([
    { name: "matching model and thinking", candidate: strong, matches: true },
    {
      name: "unspecified thinking",
      candidate: { ...strong, thinkingLevel: undefined },
      matches: true,
    },
    {
      name: "matching tools in a different order",
      candidate: { ...strong, tools: [...originalTools].reverse() },
      matches: true,
    },
    { name: "empty tools are a no-op", candidate: { ...strong, tools: [] }, matches: true },
    { name: "different provider", candidate: { ...strong, provider: "other" }, matches: false },
    { name: "different model", candidate: xstrong, matches: false },
    {
      name: "different thinking",
      candidate: { ...strong, thinkingLevel: "xhigh" },
      matches: false,
    },
    { name: "different tools", candidate: { ...strong, tools: ["read"] }, matches: false },
    { name: "unknown tools", candidate: { ...strong, tools: ["unknown"] }, matches: false },
    {
      name: "instructions must be explicitly activated",
      candidate: { ...strong, instructions: "Plan only" },
      matches: false,
    },
    {
      name: "missing model",
      candidate: { provider: "openai", thinkingLevel: "high" },
      matches: false,
    },
    { name: "missing provider", candidate: { model: "gpt-6.1-sol" }, matches: false },
    { name: "empty preset", candidate: {}, matches: false },
  ])("$name", async ({ candidate, matches }) => {
    const harness = createHarness({ presets: { candidate } });
    await start(harness);

    expect(harness.ui.setStatus).toHaveBeenLastCalledWith(
      "preset",
      matches ? "preset:candidate" : undefined,
    );
    expectNoSettingsChanged(harness);
  });

  testCases("leaves unmatched startup settings alone and cycles to the first preset", async () => {
    const harness = createHarness();
    harness.ctx.model = { provider: "openai", id: "other-model" } as Model<Api>;
    await start(harness);

    expect(harness.ui.setStatus).toHaveBeenLastCalledWith("preset", undefined);
    expectNoSettingsChanged(harness);
    await cycle(harness);
    expect(harness.ui.setStatus).toHaveBeenLastCalledWith("preset", "preset:strong");
  });

  testCases("handles a missing current model", async () => {
    const harness = createHarness();
    harness.ctx.model = undefined;
    await start(harness);

    expect(harness.ui.setStatus).toHaveBeenLastCalledWith("preset", undefined);
    expectNoSettingsChanged(harness);
  });

  testCases("explicit --preset takes precedence over a matching default", async () => {
    const harness = createHarness({ flag: "xstrong" });
    await start(harness);

    expect(harness.ui.setStatus).toHaveBeenLastCalledWith("preset", "preset:xstrong");
    expect(harness.api.setModel).toHaveBeenCalledExactlyOnceWith({
      provider: "openai",
      id: "gpt-6-astra",
    });
  });

  testCases("a saved preset takes precedence over startup recognition", async () => {
    const harness = createHarness({ savedName: "xstrong" });
    await start(harness);

    expect(harness.ui.setStatus).toHaveBeenLastCalledWith("preset", "preset:xstrong");
    expectNoSettingsChanged(harness);
  });
});
