import type { ContextUsage, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const horizontalPadding = 1;
const bottomPaddingLines = 1;

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

const formatContextUsage = (usage: ContextUsage | undefined) => {
  if (!usage) return "ctx n/a";

  const window = formatTokenCount(usage.contextWindow);
  if (usage.tokens === null || usage.percent === null) return `ctx ?/${window}`;

  return `ctx ${formatTokenCount(usage.tokens)}/${window} ${usage.percent.toFixed(1)}%`;
};

const hiddenStatusKeys = new Set(["codex-status"]);
const backgroundBashStatusKey = "backgroundBashTmuxCommands";

const formatBackgroundBashStatus = (value: string) =>
  `${value} background proc${value === "1" ? "" : "s"}`;

const formatStatus = (key: string, value: string) => {
  if (key === backgroundBashStatusKey) return formatBackgroundBashStatus(value);
  // if (key === "fast-priority") return value.replace("OpenAI fast mode", "Fast mode");
  return value;
};

const getStatuses = (statuses: ReadonlyMap<string, string>) =>
  Array.from(statuses.entries())
    .filter(([key, value]) => Boolean(value) && !hiddenStatusKeys.has(key))
    .map(([key, value]) => formatStatus(key, value))
    .join(" ");

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setFooter((_tui, theme, footerData) => ({
      invalidate() {},
      render(width: number): string[] {
        const model = ctx.model?.id ?? "no-model";
        const usage = formatContextUsage(ctx.getContextUsage());
        const thinkingLevel = pi.getThinkingLevel();
        const statuses = getStatuses(footerData.getExtensionStatuses());
        const thinking = theme.getThinkingBorderColor(thinkingLevel)(thinkingLevel);
        const left = `${theme.fg("dim", `${model} · `)}${thinking}${theme.fg("dim", ` · ${usage}`)}`;
        const right = theme.fg("dim", statuses);
        const line = padFooterLine(joinFooter(left, right, width - horizontalPadding * 2), width);
        const bottomPadding = Array.from({ length: bottomPaddingLines }, () => "");

        return [line, ...bottomPadding];
      },
    }));
  });
}
