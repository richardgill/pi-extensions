import { expect, it, vi } from "vitest";

import speedExtension from "../src/index";

vi.mock(import("../src/config"), async (original) => {
  const { configSchema } = await original();
  return { configSchema, loadSpeedConfig: () => configSchema.parse({}) };
});

const openai = {
  api: "openai-responses",
  provider: "openai",
  id: "gpt-6.2-sol",
  baseUrl: "https://api.openai.com/v1",
};
const anthropic = {
  api: "anthropic-messages",
  provider: "anthropic",
  id: "claude-opus-5-5",
  baseUrl: "https://api.anthropic.com",
};

const testCases = it;
testCases.each([
  { label: "scales ultrafast", model: openai, flag: "ultrafast", served: "ultrafast", total: 6 },
  {
    label: "leaves a downgrade priced by Pi",
    model: openai,
    flag: "ultrafast",
    served: "priority",
  },
  {
    label: "scales Claude with a response model alias",
    model: anthropic,
    flag: "fast",
    responseModel: "dated-opus-id",
    total: 2,
  },
  {
    label: "scales partial usage on abort",
    model: anthropic,
    flag: "fast",
    stopReason: "aborted",
    total: 2,
  },
  {
    label: "leaves an Anthropic server-side fallback priced by Pi",
    model: {
      ...anthropic,
      id: "claude-fable-5-2",
      compat: { allowedFallbackModels: [{ provider: "anthropic", model: "claude-opus-5" }] },
    },
    responseModel: "claude-opus-5",
    flag: "fast",
  },
  {
    label: "leaves a provider's reported total alone",
    model: anthropic,
    flag: "fast",
    totalFromProvider: true,
  },
])(
  "$label",
  ({ model, flag, served, responseModel, totalFromProvider, stopReason = "stop", total }) => {
    const ctx = {
      model,
      modelRegistry: { getAll: () => [model] },
      ui: { setStatus: vi.fn() },
    };
    const handlers = new Map<string, (event: unknown, context: unknown) => unknown>();
    const pi = {
      on: (name: string, handler: (event: unknown, context: unknown) => unknown) =>
        handlers.set(name, handler),
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      getFlag: () => flag,
    };
    speedExtension(pi as unknown as Parameters<typeof speedExtension>[0]);

    handlers.get("session_start")?.({}, ctx);
    handlers.get("before_provider_request")?.({ payload: { model: model.id } }, ctx);
    const identity = { api: model.api, provider: model.provider, model: model.id };
    if (served) {
      handlers.get("provider_stream_event")?.(
        {
          ...identity,
          data: { type: "response.completed", response: { service_tier: served } },
        },
        ctx,
      );
    }

    const message = {
      ...identity,
      role: "assistant",
      responseModel,
      stopReason,
      usage: {
        cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1, totalFromProvider },
      },
    };
    const result = handlers.get("message_end")?.({ message }, ctx);
    if (total === undefined) expect(result).toBeUndefined();
    else expect(result).toMatchObject({ message: { usage: { cost: { input: total, total } } } });
  },
);
