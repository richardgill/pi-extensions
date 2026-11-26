import { minimatch } from "minimatch";

import type { SpeedConfig } from "./config";

type Model = { api: string; id: string; provider: string; baseUrl: string };
type Family = SpeedConfig["modelFamilies"][string];

const matchesFamily = (model: Pick<Model, "api" | "id">, family: Family) =>
  family.api === model.api &&
  family.models.some((pattern) => minimatch(model.id, pattern, { nocase: true }));

export const findFamily = (config: SpeedConfig, model: Model | undefined) => {
  if (!model) return undefined;

  const matches = Object.entries(config.modelFamilies).filter(([, family]) =>
    matchesFamily(model, family),
  );
  if (matches.length > 1) {
    const names = matches.map(([name]) => JSON.stringify(name)).join(", ");
    throw new Error(
      `speed.jsonc: ${model.provider}/${model.id} matches multiple families: ${names}`,
    );
  }

  return matches[0];
};

const canonicalTier = (tier: string) => (tier === "fast" ? "priority" : tier);

export const servedOtherTier = (data: unknown, requested: string) => {
  const event = data as { type?: string; response?: { service_tier?: unknown } } | null;
  if (event?.type !== "response.completed" && event?.type !== "response.incomplete") return false;

  const served = event.response?.service_tier;
  return typeof served === "string" && canonicalTier(served) !== canonicalTier(requested);
};

// Display slower entries first; each family declares its entries fastest first.
export const speedNames = (config: SpeedConfig) => [
  "off",
  ...new Set(
    Object.values(config.modelFamilies)
      .flatMap(({ speeds }) => speeds.map(({ name }) => name))
      .reverse(),
  ),
];

export const resolveSpeed = ({
  config,
  model,
  live,
  flag,
}: {
  config: SpeedConfig;
  model?: Model;
  live?: string;
  flag?: string;
}) => {
  const [familyName, family] = findFamily(config, model) ?? [];
  const requested = live ?? flag ?? family?.default ?? "off";
  let source: string | undefined;
  if (live !== undefined) source = "/speed";
  else if (flag !== undefined) source = "--speed";

  const speeds = family?.speeds ?? [];
  const index = speeds.findIndex(({ name }) => name === requested);
  const host = model && index >= 0 ? URL.parse(model.baseUrl)?.host : undefined;
  const blocked = host && Object.hasOwn(config.unavailable, host) ? config.unavailable[host] : [];
  const tier =
    index >= 0 ? speeds.slice(index).find(({ name }) => !blocked.includes(name)) : undefined;

  return {
    requested,
    source,
    familyName,
    family,
    tier,
    applied: tier?.name ?? "off",
    unsupported: index < 0 && requested !== "off",
    blockedHost: index >= 0 && tier?.name !== requested ? host : undefined,
  };
};

export const pickerSpeedNames = (config: SpeedConfig, model: Model | undefined) =>
  speedNames(config).filter((live) => resolveSpeed({ config, model, live }).applied === live);
