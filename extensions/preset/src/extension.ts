import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { z } from "zod";

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

export const ThinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export type Preset = {
  provider?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  tools?: string[];
  instructions?: string;
  instructionsFile?: string;
};

export const PresetSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  thinkingLevel: ThinkingLevelSchema.optional(),
  tools: z.array(z.string()).optional(),
  instructions: z.string().optional(),
  instructionsFile: z.string().optional(),
});

export type PresetsConfig = Record<string, Preset>;

export type PresetOptions = {
  presets?: PresetsConfig;
  commandName?: string;
  flagName?: string;
  cycleShortcut?: KeyId | false;
  defaultTools?: string[];
  persistState?: boolean;
  instructionsBaseDir?: string;
};

type ResolvedOptions = {
  presets: PresetsConfig;
  commandName: string;
  flagName: string;
  cycleShortcut: KeyId | false;
  defaultTools: string[];
  persistState: boolean;
  instructionsBaseDir: string;
};

type OriginalState = {
  model: Model<Api> | undefined;
  thinkingLevel: ThinkingLevel;
  tools: string[];
};

type PresetState = {
  activeName: string | undefined;
  activePreset: Preset | undefined;
  original: OriginalState | undefined;
  warnedInstructionsErrors: Set<string>;
};

type PresetEntry = { data?: { name?: string } };

export const DEFAULT_OPTIONS: ResolvedOptions = {
  presets: {},
  commandName: "preset",
  flagName: "preset",
  cycleShortcut: "ctrl+shift+u",
  defaultTools: ["read", "bash", "edit", "write"],
  persistState: true,
  instructionsBaseDir: process.cwd(),
};

const PresetOptionsSchema = z.object({
  presets: z.record(z.string(), PresetSchema).default(() => ({ ...DEFAULT_OPTIONS.presets })),
  commandName: z.string().default(DEFAULT_OPTIONS.commandName),
  flagName: z.string().default(DEFAULT_OPTIONS.flagName),
  cycleShortcut: z.union([z.string(), z.literal(false)]).default(DEFAULT_OPTIONS.cycleShortcut),
  defaultTools: z.array(z.string()).default(() => [...DEFAULT_OPTIONS.defaultTools]),
  persistState: z.boolean().default(DEFAULT_OPTIONS.persistState),
  instructionsBaseDir: z.string().default(() => DEFAULT_OPTIONS.instructionsBaseDir),
});

export const resolveOptions = (options: PresetOptions = {}): ResolvedOptions =>
  PresetOptionsSchema.parse(options) as ResolvedOptions;

const createState = (): PresetState => ({
  activeName: undefined,
  activePreset: undefined,
  original: undefined,
  warnedInstructionsErrors: new Set(),
});

const expandHome = (filePath: string): string =>
  filePath === "~" || filePath.startsWith("~/") || filePath.startsWith(`~${path.sep}`)
    ? path.join(os.homedir(), filePath.slice(2))
    : filePath;

export const resolveInstructionsPath = (filePath: string, baseDir: string): string => {
  const expanded = expandHome(filePath);
  return path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
};

export const resolvePresetInstructions = (
  preset: Preset,
  baseDir: string,
): { text: string | undefined; error: string | undefined } => {
  if (!preset.instructionsFile) return { text: preset.instructions, error: undefined };
  const filePath = resolveInstructionsPath(preset.instructionsFile, baseDir);
  let fileText: string;
  try {
    fileText = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      text: preset.instructions,
      error: `Preset instructions file ${filePath} could not be read: ${message}`,
    };
  }
  const text = preset.instructions ? `${fileText}\n\n${preset.instructions}` : fileText;
  return { text, error: undefined };
};

const snapshotOriginalState = (
  state: PresetState,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): void => {
  if (state.activeName !== undefined) return;
  state.original = {
    model: ctx.model,
    thinkingLevel: pi.getThinkingLevel(),
    tools: pi.getActiveTools(),
  };
};

const applyPresetModel = async (
  name: string,
  preset: Preset,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): Promise<void> => {
  if (!preset.provider || !preset.model) return;
  const model = ctx.modelRegistry.find(preset.provider, preset.model);
  if (!model) {
    ctx.ui.notify(
      `Preset "${name}": Model ${preset.provider}/${preset.model} not found`,
      "warning",
    );
    return;
  }
  const success = await pi.setModel(model);
  if (!success) {
    ctx.ui.notify(`Preset "${name}": No API key for ${preset.provider}/${preset.model}`, "warning");
  }
};

const applyPresetTools = (
  name: string,
  preset: Preset,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): void => {
  if (!preset.tools || preset.tools.length === 0) return;
  const allToolNames = pi.getAllTools().map((tool) => tool.name);
  const validTools = preset.tools.filter((tool) => allToolNames.includes(tool));
  const invalidTools = preset.tools.filter((tool) => !allToolNames.includes(tool));
  if (invalidTools.length > 0) {
    ctx.ui.notify(`Preset "${name}": Unknown tools: ${invalidTools.join(", ")}`, "warning");
  }
  if (validTools.length > 0) {
    pi.setActiveTools(validTools);
  }
};

const updateStatus = (state: PresetState, ctx: ExtensionContext): void => {
  const value = state.activeName
    ? ctx.ui.theme.fg("accent", `preset:${state.activeName}`)
    : undefined;
  ctx.ui.setStatus("preset", value);
};

const applyPreset = async (
  name: string,
  preset: Preset,
  state: PresetState,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): Promise<void> => {
  snapshotOriginalState(state, ctx, pi);
  state.warnedInstructionsErrors.clear();
  await applyPresetModel(name, preset, ctx, pi);
  if (preset.thinkingLevel) {
    pi.setThinkingLevel(preset.thinkingLevel);
  }
  applyPresetTools(name, preset, ctx, pi);
  state.activeName = name;
  state.activePreset = preset;
};

const clearPreset = async (
  state: PresetState,
  options: ResolvedOptions,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): Promise<void> => {
  state.activeName = undefined;
  state.activePreset = undefined;
  state.warnedInstructionsErrors.clear();
  if (state.original?.model) {
    await pi.setModel(state.original.model);
  }
  pi.setThinkingLevel(state.original?.thinkingLevel ?? pi.getThinkingLevel());
  pi.setActiveTools(state.original?.tools ?? options.defaultTools);
};

const getPresetOrder = (presets: PresetsConfig): string[] => Object.keys(presets).sort();

const notifyNoPresets = (ctx: ExtensionContext): void => {
  ctx.ui.notify(
    "No presets configured. Create preset.jsonc in your pi agent config folder.",
    "warning",
  );
};

const getLastPresetEntry = (ctx: ExtensionContext): PresetEntry | undefined =>
  ctx.sessionManager
    .getEntries()
    .filter(
      (entry: { type: string; customType?: string }) =>
        entry.type === "custom" && entry.customType === "preset-state",
    )
    .pop() as PresetEntry | undefined;

const selectPresetName = async (
  presets: PresetsConfig,
  state: PresetState,
  ctx: ExtensionContext,
): Promise<string | undefined> => {
  const names = getPresetOrder(presets);
  if (names.length === 0) {
    notifyNoPresets(ctx);
    return undefined;
  }
  const choices = [
    "(none)",
    ...names.map((name) => (name === state.activeName ? `${name} (active)` : name)),
  ];
  const result = await ctx.ui.select("Select preset", choices);
  return result?.replace(/ \(active\)$/, "");
};

const activatePreset = async (
  name: string,
  options: ResolvedOptions,
  state: PresetState,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): Promise<void> => {
  const preset = options.presets[name];
  if (!preset) {
    const available = getPresetOrder(options.presets).join(", ") || "(none configured)";
    ctx.ui.notify(`Unknown preset "${name}". Available: ${available}`, "error");
    return;
  }
  await applyPreset(name, preset, state, ctx, pi);
  ctx.ui.notify(`Preset "${name}" activated`, "info");
  updateStatus(state, ctx);
};

const handlePresetSelection = async (
  selected: string | undefined,
  options: ResolvedOptions,
  state: PresetState,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): Promise<void> => {
  if (!selected) return;
  if (selected === "(none)") {
    await clearPreset(state, options, ctx, pi);
    ctx.ui.notify("Preset cleared, defaults restored", "info");
    updateStatus(state, ctx);
    return;
  }
  await activatePreset(selected, options, state, ctx, pi);
};

const cyclePreset = async (
  options: ResolvedOptions,
  state: PresetState,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): Promise<void> => {
  const names = getPresetOrder(options.presets);
  if (names.length === 0) {
    notifyNoPresets(ctx);
    return;
  }
  const cycleList = ["(none)", ...names];
  const currentIndex = cycleList.indexOf(state.activeName ?? "(none)");
  const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % cycleList.length;
  await handlePresetSelection(cycleList[nextIndex], options, state, ctx, pi);
};

const restorePresetName = (
  options: ResolvedOptions,
  state: PresetState,
  ctx: ExtensionContext,
): void => {
  const entry = getLastPresetEntry(ctx);
  const name = entry?.data?.name;
  if (!name) return;
  const preset = options.presets[name];
  if (!preset) return;
  state.activeName = name;
  state.activePreset = preset;
};

const handleSessionStart = async (
  options: ResolvedOptions,
  state: PresetState,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): Promise<void> => {
  const presetFlag = pi.getFlag(options.flagName);
  if (typeof presetFlag === "string" && presetFlag) {
    await activatePreset(presetFlag, options, state, ctx, pi);
    return;
  }
  restorePresetName(options, state, ctx);
  updateStatus(state, ctx);
};

const registerShortcut = (options: ResolvedOptions, state: PresetState, pi: ExtensionAPI): void => {
  if (!options.cycleShortcut) return;
  pi.registerShortcut(options.cycleShortcut, {
    description: "Cycle presets",
    handler: async (ctx) => {
      await cyclePreset(options, state, ctx, pi);
    },
  });
};

const registerCommand = (options: ResolvedOptions, state: PresetState, pi: ExtensionAPI): void => {
  pi.registerCommand(options.commandName, {
    description: "Switch preset configuration",
    handler: async (args, ctx) => {
      const selected = args?.trim() || (await selectPresetName(options.presets, state, ctx));
      await handlePresetSelection(selected, options, state, ctx, pi);
    },
  });
};

export const preset = (input: PresetOptions = {}) => {
  const options = resolveOptions(input);
  const state = createState();

  return (pi: ExtensionAPI): void => {
    pi.registerFlag(options.flagName, {
      description: "Preset configuration to use",
      type: "string",
    });
    registerShortcut(options, state, pi);
    registerCommand(options, state, pi);
    pi.on("before_agent_start", async (event, ctx) => {
      const preset = state.activePreset;
      if (!preset) return;
      const { text, error } = resolvePresetInstructions(preset, options.instructionsBaseDir);
      if (error && !state.warnedInstructionsErrors.has(error)) {
        state.warnedInstructionsErrors.add(error);
        ctx.ui.notify(error, "warning");
      }
      if (!text) return;
      return { systemPrompt: `${event.systemPrompt}\n\n${text.trimEnd()}` };
    });
    pi.on("session_start", async (_event, ctx) => {
      await handleSessionStart(options, state, ctx, pi);
    });
    pi.on("turn_start", async () => {
      if (options.persistState && state.activeName) {
        pi.appendEntry("preset-state", { name: state.activeName });
      }
    });
  };
};

export const extension = preset;
