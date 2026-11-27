import { loadConfigOrDefault } from "@richardgill/pi-config";
import { z } from "zod";

const nonEmpty = z.string().trim().min(1);
const host = z
  .string()
  .min(1)
  .refine((value) => value === value.trim().toLowerCase(), "Use a lowercase host");
const speedEntry = z.strictObject({
  name: nonEmpty.refine((speed) => speed !== "off" && speed !== "status", "Reserved speed name"),
  icon: z.string().default(""),
  patch: z.record(z.string(), z.unknown()),
  costMultiplier: z.number().positive().default(1),
});

const offers = (family: { speeds: { name: string }[] }, speed: string) =>
  speed === "off" || family.speeds.some(({ name }) => name === speed);
const badDefault = "Default must be off or a speed in this family";

const modelFamily = z
  .strictObject({
    api: nonEmpty,
    models: z.array(nonEmpty).min(1),
    default: nonEmpty.default("off"),
    speeds: z.array(speedEntry).min(1),
  })
  .refine(({ speeds }) => new Set(speeds.map(({ name }) => name)).size === speeds.length, {
    path: ["speeds"],
    message: "Duplicate speed names",
  })
  .refine((family) => offers(family, family.default), { path: ["default"], message: badDefault });

export const configSchema = z
  .strictObject({
    modelFamilies: z.record(z.string().min(1), modelFamily).prefault({
      "claude-5": {
        api: "anthropic-messages",
        models: ["claude-opus-5-*", "claude-fable-5-*"],
        default: "off",
        speeds: [{ name: "fast", patch: { speed: "fast" }, costMultiplier: 2 }],
      },
      "gpt-6": {
        api: "openai-responses",
        models: ["gpt-6.*"],
        default: "off",
        speeds: [
          { name: "ultrafast", patch: { service_tier: "ultrafast" }, costMultiplier: 6 },
          { name: "fast", patch: { service_tier: "priority" } },
          { name: "flex", icon: "🐢", patch: { service_tier: "flex" } },
        ],
      },
    }),
    unavailable: z.record(host, z.array(nonEmpty)).default({}),
    defaults: z.record(nonEmpty, nonEmpty).default({}),
  })
  .superRefine(({ modelFamilies, defaults }, ctx) => {
    for (const [name, speed] of Object.entries(defaults)) {
      const family = Object.hasOwn(modelFamilies, name) ? modelFamilies[name] : undefined;
      const message = family ? badDefault : "Default must name a family in modelFamilies";
      if (!family || !offers(family, speed)) {
        ctx.addIssue({ code: "custom", path: ["defaults", name], message });
      }
    }
  })
  // Fold overrides into each family so the rest of the extension reads a single default.
  .transform(({ defaults, modelFamilies, ...config }) => ({
    ...config,
    modelFamilies: Object.fromEntries(
      Object.entries(modelFamilies).map(([name, family]) => [
        name,
        { ...family, default: Object.hasOwn(defaults, name) ? defaults[name] : family.default },
      ]),
    ),
  }));

export type SpeedConfig = z.infer<typeof configSchema>;

// Template preprocessing drops unknown fields before strict validation can reject them.
export const loadSpeedConfig = () =>
  loadConfigOrDefault({ filename: "speed.jsonc", schema: configSchema, renderTemplates: false });
