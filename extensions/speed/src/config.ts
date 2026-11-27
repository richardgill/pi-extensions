import { loadConfigOrDefault } from "@richardgill/pi-config";
import { z } from "zod";

const nonEmpty = z.string().trim().min(1);
const host = z
  .string()
  .min(1)
  .refine((value) => value === value.trim().toLowerCase(), "Use a lowercase host");
const speedEntry = z.strictObject({
  name: nonEmpty.refine((speed) => speed !== "off" && speed !== "status", "Reserved speed name"),
  patch: z.record(z.string(), z.unknown()),
  costMultiplier: z.number().positive().default(1),
});

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
  .refine(
    (family) =>
      family.default === "off" || family.speeds.some(({ name }) => name === family.default),
    { path: ["default"], message: "Default must be off or a speed in this family" },
  );

export const configSchema = z.strictObject({
  modelFamilies: z.record(z.string().min(1), modelFamily).prefault({
    claude: {
      api: "anthropic-messages",
      models: ["claude-opus-5-5*", "claude-fable-5-2*"],
      default: "off",
      speeds: [{ name: "fast", patch: { speed: "fast" }, costMultiplier: 2 }],
    },
    gpt: {
      api: "openai-responses",
      models: ["gpt-6.2-{astra,sol}{,-20??-??-??}"],
      default: "fast",
      speeds: [
        { name: "ultrafast", patch: { service_tier: "ultrafast" }, costMultiplier: 6 },
        { name: "fast", patch: { service_tier: "priority" } },
      ],
    },
    gpt61Sol: {
      api: "openai-responses",
      models: ["gpt-6.1-sol{,-20??-??-??}"],
      default: "fast",
      speeds: [
        { name: "ultrafast", patch: { service_tier: "ultrafast" }, costMultiplier: 6 },
        { name: "fast", patch: { service_tier: "priority" } },
        { name: "flex", patch: { service_tier: "flex" } },
      ],
    },
    gpt61Terra: {
      api: "openai-responses",
      models: ["gpt-6.1-terra{,-20??-??-??}"],
      default: "fast",
      speeds: [
        { name: "fast", patch: { service_tier: "priority" } },
        { name: "flex", patch: { service_tier: "flex" } },
      ],
    },
  }),
  unavailable: z.record(host, z.array(nonEmpty)).default({}),
});

export type SpeedConfig = z.infer<typeof configSchema>;

// Template preprocessing drops unknown fields before strict validation can reject them.
export const loadSpeedConfig = () =>
  loadConfigOrDefault({ filename: "speed.jsonc", schema: configSchema, renderTemplates: false });
