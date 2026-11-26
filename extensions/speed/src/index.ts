import { writeSync } from "node:fs";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { loadSpeedConfig } from "./config";
import { findFamily, pickerSpeedNames, resolveSpeed, servedOtherTier, speedNames } from "./speed";

type Resolution = ReturnType<typeof resolveSpeed>;
type RequestIdentity = Pick<AssistantMessage, "api" | "provider" | "model">;
// The repo pins Pi types from before this 1.6.1 hook was available.
type SpeedExtensionAPI = ExtensionAPI & {
  on(
    event: "provider_stream_event",
    handler: (event: RequestIdentity & { data: unknown }) => void,
  ): void;
};

const liveKey = Symbol.for("@richardgill/pi-speed/live");
const processState = globalThis as typeof globalThis & { [liveKey]?: string };

const footer = (speed: Resolution) => {
  if (speed.requested === "off") return undefined;
  if (speed.blockedHost) return `⚡ ${speed.requested}→${speed.applied}`;
  if (speed.unsupported) return `⚡ ${speed.requested} n/a`;
  return speed.applied === "flex" ? "🐢 flex" : `⚡ ${speed.applied}`;
};

const status = (speed: Resolution, model: ExtensionContext["model"]) => {
  const { requested, source, family, familyName, tier, blockedHost, unsupported, applied } = speed;
  const selection = `Speed: ${requested}${source ? ` (from ${source})` : ""}`;
  const familyDefault = family ? ` · ${familyName} default: ${family.default}` : "";
  const modelLabel = model ? `${model.provider}/${model.id}` : "none";
  const familyLabel = familyName ? ` (${familyName})` : "";
  const cost = tier && tier.costMultiplier !== 1 ? ` · ${tier.costMultiplier}x cost` : "";
  const reason = blockedHost ? ` (${requested} unavailable on ${blockedHost})` : "";
  const unavailable = unsupported ? ` (${requested} n/a)` : "";
  return `${selection}${familyDefault}\nModel: ${modelLabel}${familyLabel} → ${applied}${cost}${reason}${unavailable}`;
};

const fail = (message: string): never => {
  // Pi restores the terminal on exit; print after that so the TUI does not erase the error.
  process.once("exit", () => writeSync(2, `pi-speed: ${message}\n`));
  process.exit(1);
};

const isModelPayload = (payload: unknown, model: Model<Api>): payload is Record<string, unknown> =>
  Object.prototype.toString.call(payload) === "[object Object]" &&
  (payload as Record<string, unknown>).model === model.id;

const matchesRequest = (event: RequestIdentity, model: Model<Api>) =>
  event.api === model.api && event.provider === model.provider && event.model === model.id;

const usedServerFallback = (message: AssistantMessage, model: Model<Api>) => {
  if (!message.responseModel || model.api !== "anthropic-messages") return false;
  const compat = model.compat as
    | { allowedFallbackModels?: { provider: string; model: string }[] }
    | undefined;
  return compat?.allowedFallbackModels?.some(
    (fallback) => fallback.provider === model.provider && fallback.model === message.responseModel,
  );
};

const scaleCost = (message: AssistantMessage, multiplier: number) => {
  const { usage } = message;
  const cost: AssistantMessage["usage"]["cost"] & { totalFromProvider?: boolean } = usage.cost;
  if (cost.totalFromProvider) return;

  return {
    message: {
      ...message,
      usage: {
        ...usage,
        cost: {
          ...cost,
          input: cost.input * multiplier,
          output: cost.output * multiplier,
          cacheRead: cost.cacheRead * multiplier,
          cacheWrite: cost.cacheWrite * multiplier,
          total: cost.total * multiplier,
        },
      },
    },
  };
};

export default (pi: SpeedExtensionAPI) => {
  const config = loadSpeedConfig();
  const names = speedNames(config);
  const choices = `Use one of: ${names.join(", ")}`;
  let pending: { model: Model<Api>; tier: NonNullable<Resolution["tier"]> } | undefined;

  const current = (ctx: ExtensionContext) => {
    const flag = pi.getFlag("speed");
    return resolveSpeed({
      config,
      model: ctx.model,
      live: processState[liveKey],
      flag: typeof flag === "string" ? flag : undefined,
    });
  };
  const refreshFooter = (ctx: ExtensionContext) =>
    ctx.ui.setStatus("pi-speed", footer(current(ctx)));

  pi.registerFlag("speed", { type: "string", description: `Set request speed. ${choices}` });
  pi.on("session_start", (_event, ctx) => {
    const value = pi.getFlag("speed");
    if (typeof value === "string" && !names.includes(value)) {
      fail(`invalid --speed ${JSON.stringify(value)}. ${choices}`);
    }

    try {
      for (const model of ctx.modelRegistry.getAll()) findFamily(config, model);
      refreshFooter(ctx);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  });
  pi.on("model_select", (_event, ctx) => refreshFooter(ctx));

  pi.registerCommand("speed", {
    description: "Choose request speed for this process, or show /speed status",
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (arg === "status") {
        ctx.ui.notify(status(current(ctx), ctx.model), "info");
        return;
      }

      const selected =
        arg || (await ctx.ui.select("Speed for this process", pickerSpeedNames(config, ctx.model)));
      if (selected === undefined) return;
      if (!names.includes(selected)) {
        ctx.ui.notify(`Invalid speed ${JSON.stringify(selected)}. ${choices}`, "error");
        return;
      }

      processState[liveKey] = selected;
      const speed = current(ctx);
      ctx.ui.setStatus("pi-speed", footer(speed));
      ctx.ui.notify(status(speed, ctx.model), "info");
    },
  });

  pi.on("before_provider_request", ({ payload }, ctx) => {
    pending = undefined;
    const { model } = ctx;
    if (!model || !isModelPayload(payload, model)) return;

    const { tier } = current(ctx);
    if (!tier) return;
    if (tier.costMultiplier !== 1) pending = { model, tier };
    return { ...payload, ...tier.patch };
  });

  pi.on("provider_stream_event", (event) => {
    if (!pending || !matchesRequest(event, pending.model)) return;

    const requested = pending.tier.patch.service_tier;
    if (typeof requested === "string" && servedOtherTier(event.data, requested))
      pending = undefined;
  });

  pi.on("message_end", ({ message }) => {
    if (message.role !== "assistant") return;
    // Cache warming has no message_end; every main request overwrites its pending correction.
    const request = pending;
    pending = undefined;
    if (!request || !matchesRequest(message, request.model)) return;
    if (usedServerFallback(message, request.model)) return;

    return scaleCost(message, request.tier.costMultiplier);
  });
};
