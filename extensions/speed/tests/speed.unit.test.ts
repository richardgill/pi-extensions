import { describe, expect, it } from "vitest";

import { configSchema } from "../src/config";
import {
  findFamily,
  pickerSpeedNames,
  resolveSpeed,
  servedOtherTier,
  speedNames,
} from "../src/speed";

const testCases = it;

const gateway = "gateway.example.com";
const claude = {
  api: "anthropic-messages",
  id: "claude-opus-5-5-20260501",
  provider: "anthropic",
  baseUrl: `https://${gateway}/v1`,
};
const gpt = { ...claude, api: "openai-responses", id: "gpt-6.2-sol", provider: "openai" };
const defaults = configSchema.parse({});
const gatewayConfig = configSchema.parse({ unavailable: { [gateway]: ["ultrafast"] } });
const allBlocked = configSchema.parse({
  unavailable: { [gateway]: ["ultrafast", "fast", "flex"] },
});
const fastBlocked = configSchema.parse({ unavailable: { [gateway]: ["fast"] } });
const direct = { ...gpt, baseUrl: "https://api.openai.com/v1" };

const precedenceCases = [
  {
    label: "live off overrides CLI and default",
    model: gpt,
    live: "off",
    flag: "flex",
    requested: "off",
    source: "/speed",
  },
  {
    label: "CLI overrides model default",
    model: gpt,
    flag: "flex",
    requested: "flex",
    source: "--speed",
  },
  { label: "Claude default", model: claude, requested: "off", source: undefined },
  { label: "GPT default", model: gpt, requested: "fast", source: undefined },
  { label: "no model defaults to off", requested: "off", source: undefined },
];

const tierCases = [
  {
    label: "Claude fast and dated ID",
    model: claude,
    live: "fast",
    family: "claude",
    applied: "fast",
    patch: { speed: "fast" },
    multiplier: 2,
  },
  {
    label: "unsupported tier does not fall back",
    model: claude,
    live: "ultrafast",
    family: "claude",
    unsupported: true,
  },
  {
    label: "correct API required",
    model: { ...claude, api: gpt.api },
    live: "fast",
    unsupported: true,
  },
  {
    label: "unsupported model",
    model: { ...gpt, id: "gpt-other" },
    live: "fast",
    unsupported: true,
  },
  {
    label: "priority has no extra multiplier",
    model: gpt,
    live: "fast",
    family: "gpt",
    applied: "fast",
    patch: { service_tier: "priority" },
    multiplier: 1,
  },
  {
    label: "gateway steps down",
    model: gpt,
    config: gatewayConfig,
    live: "ultrafast",
    family: "gpt",
    applied: "fast",
    patch: { service_tier: "priority" },
    multiplier: 1,
    blockedHost: gateway,
  },
  {
    label: "direct ultrafast",
    model: direct,
    live: "ultrafast",
    family: "gpt",
    applied: "ultrafast",
    patch: { service_tier: "ultrafast" },
    multiplier: 6,
  },
  {
    label: "never steps up to ultrafast",
    model: gpt,
    config: fastBlocked,
    live: "fast",
    family: "gpt",
    applied: "flex",
    patch: { service_tier: "flex" },
    multiplier: 1,
    blockedHost: gateway,
  },
  {
    label: "all lower tiers blocked",
    model: gpt,
    config: allBlocked,
    live: "ultrafast",
    family: "gpt",
    blockedHost: gateway,
  },
];

describe("speed resolution", () => {
  testCases.each(precedenceCases)("$label", ({ model, live, flag, requested, source }) => {
    expect(resolveSpeed({ config: defaults, model, live, flag })).toMatchObject({
      requested,
      source,
    });
  });

  testCases.each(tierCases)(
    "$label",
    ({
      config = defaults,
      model,
      live,
      family,
      applied = "off",
      patch,
      multiplier,
      blockedHost,
      unsupported = false,
    }) => {
      const speed = resolveSpeed({ config, model, live });
      expect(speed).toMatchObject({ familyName: family, applied, blockedHost, unsupported });
      expect(speed.tier?.patch).toEqual(patch);
      expect(speed.tier?.costMultiplier).toEqual(multiplier);
    },
  );

  it("rejects a concrete model that matches two families using Pi-style globs", () => {
    const config = configSchema.parse({
      modelFamilies: {
        ...defaults.modelFamilies,
        sol: { ...defaults.modelFamilies.gpt, models: ["gpt-6.2-{sol,astra}*"] },
      },
    });
    expect(() => findFamily(config, gpt)).toThrow(
      'openai/gpt-6.2-sol matches multiple families: "gpt", "sol"',
    );
  });
});

describe("speed picker", () => {
  testCases.each([
    {
      label: "only off and fast for Opus",
      model: claude,
      config: defaults,
      expected: ["off", "fast"],
    },
    {
      label: "no ultrafast on the gateway",
      model: gpt,
      config: gatewayConfig,
      expected: ["off", "flex", "fast"],
    },
    {
      label: "includes ultrafast on a direct endpoint",
      model: direct,
      config: gatewayConfig,
      expected: ["off", "flex", "fast", "ultrafast"],
    },
    {
      label: "only off when all tiers are blocked",
      model: gpt,
      config: allBlocked,
      expected: ["off"],
    },
    { label: "only off without a model", model: undefined, config: defaults, expected: ["off"] },
  ])("$label", ({ model, config, expected }) => {
    expect(pickerSpeedNames(config, model)).toEqual(expected);
  });
});

describe("served Responses tier", () => {
  testCases.each([
    { event: "response.completed", requested: "ultrafast", served: "priority", differs: true },
    { event: "response.incomplete", requested: "ultrafast", served: "fast", differs: true },
    { event: "response.completed", requested: "priority", served: "fast", differs: false },
    { event: "response.completed", requested: "ultrafast", served: "ultrafast", differs: false },
    { event: "response.completed", requested: "ultrafast", served: undefined, differs: false },
    { event: "response.created", requested: "ultrafast", served: "default", differs: false },
  ])("$event: $requested requested, $served served", ({ event, requested, served, differs }) => {
    expect(servedOtherTier({ type: event, response: { service_tier: served } }, requested)).toBe(
      differs,
    );
  });
});

const family = {
  api: gpt.api,
  models: [gpt.id],
  speeds: [{ name: "eco", patch: { service_tier: "flex" } }],
};
const configCases = [
  { label: "unknown root key", config: { unavaliable: {} }, error: "Unrecognized key" },
  {
    label: "noncanonical host key",
    config: { unavailable: { "EXAMPLE.com": ["fast"] } },
    error: "Use a lowercase host",
  },
  {
    label: "unknown family key",
    config: { modelFamilies: { custom: { ...family, glob: "*" } } },
    error: "Unrecognized key",
  },
  {
    label: "unknown speed key",
    config: {
      modelFamilies: { custom: { ...family, speeds: [{ ...family.speeds[0], multiplier: 2 }] } },
    },
    error: "Unrecognized key",
  },
  {
    label: "duplicate speed",
    config: {
      modelFamilies: { custom: { ...family, speeds: [...family.speeds, ...family.speeds] } },
    },
    error: "Duplicate speed names",
  },
  {
    label: "default outside family",
    config: { modelFamilies: { custom: { ...family, default: "fast" } } },
    error: "Default must be off or a speed in this family",
  },
  {
    label: "reserved command name",
    config: {
      modelFamilies: { custom: { ...family, speeds: [{ ...family.speeds[0], name: "status" }] } },
    },
    error: "Reserved speed name",
  },
];

describe("speed config", () => {
  testCases.each(configCases)("rejects $label", ({ config, error }) => {
    expect(() => configSchema.parse(config)).toThrow(error);
  });

  it("has no built-in endpoint restrictions", () => {
    expect(configSchema.parse({}).unavailable).toEqual({});
  });

  it("uses off plus the sorted-by-tier vocabulary from the built-in families", () => {
    expect(speedNames(defaults)).toEqual(["off", "flex", "fast", "ultrafast"]);
  });

  it("replaces model families (and accepts user-defined speeds)", () => {
    const config = configSchema.parse({ modelFamilies: { custom: family } });
    expect(Object.keys(config.modelFamilies)).toEqual(["custom"]);
    expect(speedNames(config)).toEqual(["off", "eco"]);
    expect(resolveSpeed({ config, model: gpt })).toMatchObject({
      familyName: "custom",
      requested: "off",
    });
  });
});
