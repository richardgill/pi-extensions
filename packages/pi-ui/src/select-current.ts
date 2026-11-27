import { DynamicBorder, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, TruncatedText, truncateToWidth } from "@earendil-works/pi-tui";

type SelectOptions = { title: string; options: readonly string[]; current?: string };

const currentMark = " ✓";
const maxVisibleRows = 10;

const selectInTui = (
  ctx: ExtensionContext,
  title: string,
  options: readonly string[],
  currentIndex: number,
) =>
  ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
    const items = options.map((value) => ({ value, label: value }));
    const currentItem = items[currentIndex];
    const accent = (text: string) => theme.fg("accent", text);
    const muted = (text: string) => theme.fg("muted", text);
    const list: SelectList = new SelectList(
      items,
      maxVisibleRows,
      {
        selectedPrefix: accent,
        selectedText: (text) =>
          list.getSelectedItem() === currentItem && text.endsWith(currentMark)
            ? accent(text.slice(0, -currentMark.length)) + currentMark
            : accent(text),
        description: muted,
        scrollInfo: muted,
        noMatch: muted,
      },
      {
        truncatePrimary: ({ item, text, maxWidth }) =>
          item === currentItem && maxWidth >= currentMark.length
            ? truncateToWidth(text, maxWidth - currentMark.length, "") + currentMark
            : truncateToWidth(text, maxWidth, ""),
      },
    );
    list.setSelectedIndex(Math.max(0, currentIndex));
    list.onSelect = ({ value }) => done(value);
    list.onCancel = () => done(undefined);

    const container = new Container();
    container.addChild(new DynamicBorder(accent));
    container.addChild(new TruncatedText(accent(theme.bold(title)), 0, 0));
    container.addChild(list);
    container.addChild(
      new TruncatedText(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 0, 0),
    );
    container.addChild(new DynamicBorder(accent));

    return {
      render: (width) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        list.handleInput(data);
        tui.requestRender();
      },
    };
  });

export const selectCurrent = async (
  ctx: ExtensionContext,
  { title, options, current }: SelectOptions,
): Promise<string | undefined> => {
  if (!ctx.hasUI || options.length === 0) return undefined;

  const currentIndex = current === undefined ? -1 : options.indexOf(current);
  if (ctx.mode === "tui") return selectInTui(ctx, title, options, currentIndex);

  const labels = [...options];
  if (currentIndex !== -1) {
    let label = options[currentIndex];
    // RPC returns the label, so it must not collide with a literal option.
    while (options.includes(label + currentMark)) label += " ";
    labels[currentIndex] = label + currentMark;
  }
  const label = await ctx.ui.select(title, labels);
  return label === undefined ? undefined : options[labels.indexOf(label)];
};
