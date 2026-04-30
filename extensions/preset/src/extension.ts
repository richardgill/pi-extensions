import type { Api, Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { KeyId } from "@mariozechner/pi-tui";
import { resolveOptions as resolveConfigOptions } from "@richardgill/pi-config";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type Preset = {
  provider?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  tools?: string[];
  instructions?: string;
};

export type PresetsConfig = Record<string, Preset>;

export type PresetOptions = {
  presets?: PresetsConfig;
  commandName?: string;
  flagName?: string;
  cycleShortcut?: KeyId | false;
  defaultTools?: string[];
  persistState?: boolean;
};

type ResolvedOptions = {
  presets: PresetsConfig;
  commandName: string;
  flagName: string;
  cycleShortcut: KeyId | false;
  defaultTools: string[];
  persistState: boolean;
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
};

type PresetEntry = { data?: { name?: string } };

export const DEFAULT_OPTIONS: ResolvedOptions = {
  presets: {},
  commandName: "preset",
  flagName: "preset",
  cycleShortcut: "ctrl+shift+u",
  defaultTools: ["read", "bash", "edit", "write"],
  persistState: true,
};

export const resolveOptions = (options: PresetOptions = {}): ResolvedOptions =>
  resolveConfigOptions<ResolvedOptions>(DEFAULT_OPTIONS, options);

const createState = (): PresetState => ({
  activeName: undefined,
  activePreset: undefined,
  original: undefined,
});

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
    pi.on("before_agent_start", async (event) => {
      if (!state.activePreset?.instructions) return;
      return { systemPrompt: `${event.systemPrompt}\n\n${state.activePreset.instructions}` };
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
