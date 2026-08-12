import type { ContextUsage, ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const horizontalPadding = 1;
const bottomPaddingLines = 1;

// GPT-5.6 Codex models expose a 372k backend window: https://github.com/earendil-works/pi/pull/6471
const contextWindowOverrides = new Map([
  ["openai-codex/gpt-5.6-sol", 372_000],
  ["openai-codex/gpt-5.6-terra", 372_000],
  ["openai-codex/gpt-5.6-luna", 372_000],
]);

const padFooterLine = (line: string, width: number) => {
  const contentWidth = Math.max(0, width - horizontalPadding * 2);
  return `${" ".repeat(horizontalPadding)}${truncateToWidth(line, contentWidth)}${" ".repeat(horizontalPadding)}`;
};

const joinFooter = (left: string, right: string, width: number) => {
  const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
  return truncateToWidth(left + pad + right, width);
};

const formatTokenCount = (tokens: number) =>
  tokens < 1000 ? `${tokens}` : `${(tokens / 1000).toFixed(1)}k`;

const formatContextUsage = (usage: ContextUsage | undefined, contextWindow: number | undefined) => {
  if (!usage || !contextWindow) return "ctx n/a";

  const window = formatTokenCount(contextWindow);
  if (usage.tokens === null || usage.percent === null) return `ctx ?/${window}`;

  const percent = (usage.tokens / contextWindow) * 100;
  return `ctx ${formatTokenCount(usage.tokens)}/${window} ${percent.toFixed(1)}%`;
};

const getContextWindow = (
  provider: string | undefined,
  modelId: string | undefined,
  usage: ContextUsage | undefined,
) => contextWindowOverrides.get(`${provider}/${modelId}`) ?? usage?.contextWindow;

const hiddenStatusKeys = new Set(["codex-status"]);
const backgroundBashStatusKey = "backgroundBashProcesses";

const formatStatus = (key: string, value: string, theme: Theme) => {
  if (key !== backgroundBashStatusKey) return theme.fg("dim", value);

  const backgroundCount = value.replace(/ procs?$/, "");
  return `${theme.fg("dim", `${backgroundCount} `)}${theme.fg("accent", theme.bold("/proc"))}`;
};

const getStatuses = (statuses: ReadonlyMap<string, string>, theme: Theme) =>
  Array.from(statuses.entries())
    .filter(([key, value]) => Boolean(value) && !hiddenStatusKeys.has(key))
    .map(([key, value]) => formatStatus(key, value, theme))
    .join(" ");

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setFooter((_tui, theme, footerData) => ({
      invalidate() {},
      render(width: number): string[] {
        const model = ctx.model?.id ?? "no-model";
        const contextUsage = ctx.getContextUsage();
        const contextWindow = getContextWindow(ctx.model?.provider, ctx.model?.id, contextUsage);
        const usage = formatContextUsage(contextUsage, contextWindow);
        const thinkingLevel = pi.getThinkingLevel();
        const statuses = getStatuses(footerData.getExtensionStatuses(), theme);
        const thinking = theme.getThinkingBorderColor(thinkingLevel)(thinkingLevel);
        const left = `${theme.fg("dim", `${model} · `)}${thinking}${theme.fg("dim", ` · ${usage}`)}`;
        const right = statuses;
        const line = padFooterLine(joinFooter(left, right, width - horizontalPadding * 2), width);
        const bottomPadding = Array.from({ length: bottomPaddingLines }, () => "");

        return [line, ...bottomPadding];
      },
    }));
  });
}
